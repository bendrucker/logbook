import { RequestCap } from "../request-cap";
import { type BackfillResult, unitFetch } from "../sync/backfill";
import { type CrawlSource, type Drain, drain, enqueue, frontierStatus } from "../sync/frontier";
import type { InstapaperKind } from "../sync/kinds";
import { advance } from "../sync/state";
import type { InstapaperOptions } from "./client";
import { liveBookmarkIds } from "./store";
import {
  CHANGES_WINDOW,
  EVERYTHING,
  FOLDERS_WINDOW,
  instapaperToken,
  type InstapaperSyncOptions,
  syncChanges,
  syncFolders,
  syncHighlights,
} from "./sync";

export interface InstapaperInvocationOptions extends Omit<InstapaperOptions, "requests"> {
  now?: Date;
}

// A unit already in the frontier keeps its status, so calling again resumes.
// The bookmarks unit is one change listing from the start of the account, and
// a highlights unit is one bookmark's highlights.
export async function backfillInstapaper(
  env: Env,
  kind: InstapaperKind,
  options: InstapaperInvocationOptions = {},
): Promise<BackfillResult> {
  // Read before anything else so an unconfigured deployment answers the caller.
  instapaperToken(env);
  const now = options.now ?? new Date();
  const requests = new RequestCap(env.RATE_CAP_INSTAPAPER);

  if (kind === "instapaper-bookmarks") {
    const folders = await syncFolders(env, { ...options, now, requests });
    if (folders.error !== null) {
      return {
        ...(await result(env, kind, [FOLDERS_WINDOW], folders.pages, folders.rowsChanged)),
        // Reported pending so a caller looping to completion calls again.
        pending: 1,
        resumeAt: folders.resumeAt,
        error: folders.error,
      };
    }
    await enqueue(env.DB, kind, [CHANGES_WINDOW], now.toISOString());
  } else {
    await enqueueHighlights(env.DB, await liveBookmarkIds(env.DB), now.toISOString(), "DO NOTHING");
  }

  // The drain takes the caller's options rather than the fixed `now` above, so
  // each of its runs stamps its own time.
  const drained = await drainInstapaper(env, kind, { ...options, requests });
  return {
    ...(await result(env, kind, drained.windows, drained.pages, drained.rowsChanged)),
    resumeAt: drained.resumeAt,
    error: drained.error,
  };
}

// Once the whole account has been read, the bookmarks are synced through the
// start of that read and the hourly change listing takes over.
export async function drainInstapaper(
  env: Env,
  kind: InstapaperKind,
  options: InstapaperSyncOptions,
): Promise<Drain> {
  const drained = await drain(env.DB, kind, crawlSource(env, kind, options));
  if (kind === "instapaper-bookmarks" && drained.error === null) {
    const read = await env.DB.prepare(
      "SELECT MIN(fetched_at) AS through, SUM(status = 'pending') AS pending FROM crawl_units" +
        " WHERE kind = 'instapaper-bookmarks'",
    ).first<{ through: string | null; pending: number | null }>();
    if (read?.through != null && read.pending === 0) {
      await advance(env.DB, kind, read.through);
    }
  }
  return drained;
}

// A bookmark the change listing returned may have gained highlights, so its
// unit goes back to pending whatever status an earlier read left it in.
export async function requeueHighlights(
  db: D1Database,
  bookmarkIds: readonly number[],
  at: string,
): Promise<void> {
  if (bookmarkIds.length === 0) {
    return;
  }
  await enqueueHighlights(
    db,
    bookmarkIds,
    at,
    "DO UPDATE SET status = 'pending', updated_at = excluded.updated_at",
  );
}

// One statement over a JSON array, since a batch of one insert per bookmark
// grows with the account past what an invocation may query.
async function enqueueHighlights(
  db: D1Database,
  bookmarkIds: readonly number[],
  at: string,
  onConflict: "DO NOTHING" | "DO UPDATE SET status = 'pending', updated_at = excluded.updated_at",
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO crawl_units (kind, window, parent, status, updated_at)" +
        " SELECT 'instapaper-highlights', value, NULL, 'pending', ?2 FROM json_each(?1) WHERE true" +
        ` ON CONFLICT (kind, window) ${onConflict}`,
    )
    .bind(JSON.stringify(bookmarkIds.map(String)), at)
    .run();
}

function crawlSource(env: Env, kind: InstapaperKind, options: InstapaperSyncOptions): CrawlSource {
  if (kind === "instapaper-highlights") {
    return {
      fetch: async (window) => {
        const run = unitFetch(await syncHighlights(env, Number(window), options));
        // A bookmark whose read fails every time would hold the drain at its
        // unit, so only a limit stops it. The failed run stays in `sync_runs`.
        return run.error !== null && run.resumeAt === null
          ? { ...run, error: null, truncated: true }
          : run;
      },
      split: () => [],
    };
  }
  return {
    fetch: async (window) => {
      if (window !== CHANGES_WINDOW) {
        throw new Error(`${window} is not an Instapaper bookmarks window`);
      }
      const changes = await syncChanges(env, EVERYTHING, options);
      await requeueHighlights(env.DB, changes.bookmarkIds, changes.fetchedAt);
      return unitFetch(changes);
    },
    // The listing has no narrower window to ask for.
    split: () => [],
  };
}

async function result(
  env: Env,
  kind: InstapaperKind,
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
