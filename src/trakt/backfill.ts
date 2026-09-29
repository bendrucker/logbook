import type { Month } from "../github/windows";
import { type BackfillResult, unitFetch } from "../sync/backfill";
import { type CrawlSource, drain, enqueue, frontierStatus } from "../sync/frontier";
import type { TraktKind } from "../sync/kinds";
import { describe, stoppedUntil } from "../sync/run";
import { PAGE_LIMIT, RequestCap, type TraktOptions, traktGet } from "./client";
import type { TraktInvocationOptions } from "./incremental";
import { archiveTraktPage } from "./raw";
import { historyPage } from "./schema";
import { syncHistoryWindow, syncRatings, traktClientId, yearWindow } from "./sync";

// Where the discovery pages that find the first year of plays archive.
const EARLIEST_WINDOW = "earliest";

// Trakt has no result cap, so a year window never splits.
export async function backfillTrakt(
  env: Env,
  kind: TraktKind,
  from: Month | null,
  options: TraktInvocationOptions = {},
): Promise<BackfillResult> {
  // Read before anything else so an unconfigured deployment answers the caller.
  const clientId = traktClientId(env);
  const requests = new RequestCap(env.RATE_CAP_TRAKT);

  if (kind === "trakt-ratings") {
    const run = await syncRatings(env, { ...options, requests });
    return {
      kind,
      windows: ["all"],
      pages: run.pages,
      rowsChanged: run.rowsChanged,
      // A read that stopped reports itself pending so a caller looping to
      // completion calls again.
      pending: run.error === null ? 0 : 1,
      irreducible: [],
      resumeAt: run.resumeAt,
      error: run.error,
    };
  }

  const now = options.now ?? new Date();
  let first: number | null;
  try {
    first =
      from?.year ??
      (await enqueuedFrom(env.DB)) ??
      (await oldestPlayYear(env, clientId, { ...options, requests }, now));
  } catch (error) {
    const resumeAt = stoppedUntil(error, now);
    if (resumeAt === null) {
      throw error;
    }
    return { ...(await result(env, kind, [], 0, 0)), pending: 1, resumeAt, error: describe(error) };
  }

  if (first !== null) {
    const last = now.getUTCFullYear();
    const years =
      first > last
        ? []
        : Array.from({ length: last - first + 1 }, (_, index) => String(first + index));
    await enqueue(env.DB, kind, years, now.toISOString());
  }

  const drained = await drain(env.DB, kind, historySource(env, { ...options, requests }));
  return {
    ...(await result(env, kind, drained.windows, drained.pages, drained.rowsChanged)),
    resumeAt: drained.resumeAt,
    error: drained.error,
  };
}

export async function drainTraktHistory(
  env: Env,
  options: TraktInvocationOptions & { requests: RequestCap },
): Promise<void> {
  const drained = await drain(env.DB, "trakt-history", historySource(env, options));
  if (drained.error !== null) {
    console.error(`trakt-history backfill drain stopped: ${drained.error}`);
  }
}

function historySource(
  env: Env,
  options: TraktOptions & { now?: Date; requests: RequestCap },
): CrawlSource {
  return {
    fetch: async (window) => {
      const now = options.now ?? new Date();
      return unitFetch(
        await syncHistoryWindow(env, yearWindow(Number(window), now, true), options),
      );
    },
    split: () => [],
  };
}

async function result(
  env: Env,
  kind: TraktKind,
  windows: string[],
  pages: number,
  rowsChanged: number,
): Promise<BackfillResult> {
  const status = (await frontierStatus(env.DB)).get(kind);
  return {
    kind,
    windows,
    pages,
    rowsChanged,
    pending: status?.pending ?? 0,
    irreducible: status?.irreducible ?? [],
    resumeAt: null,
    error: null,
  };
}

// Resumes from the years already enqueued, which skips the two requests that
// find the oldest play.
async function enqueuedFrom(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT MIN(window) AS first FROM crawl_units WHERE kind = 'trakt-history'")
    .first<{ first: string | null }>();
  return row?.first == null ? null : Number(row.first);
}

// History lists the most recent play first, so the oldest is the last item of
// the last page. Null when there are no plays at all.
async function oldestPlayYear(
  env: Env,
  clientId: string,
  options: TraktOptions,
  now: Date,
): Promise<number | null> {
  const fetchedAt = now.toISOString();
  const path = `/users/${encodeURIComponent(env.TRAKT_USER)}/history`;
  const read = async (page: number) => {
    const response = await traktGet(
      clientId,
      path,
      { page: String(page), limit: String(PAGE_LIMIT) },
      historyPage,
      options,
    );
    await archiveTraktPage(env.RAW, {
      kind: "trakt-history",
      window: EARLIEST_WINDOW,
      fetchedAt,
      page,
      body: response.body,
      status: 200,
      pagination: response.pagination,
    });
    return response;
  };

  const first = await read(1);
  const pageCount = first.pagination?.pageCount ?? 1;
  const last = pageCount > 1 ? await read(pageCount) : first;
  const oldest = last.data.at(-1);
  return oldest === undefined ? null : new Date(oldest.watched_at).getUTCFullYear();
}
