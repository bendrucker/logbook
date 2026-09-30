import type { z } from "zod";
import type { TraktKind } from "../sync/kinds";
import { recordRun, type SyncResult, syncedThrough } from "../sync/run";
import { advance } from "../sync/state";
import type { RequestCap } from "../request-cap";
import {
  PAGE_LIMIT,
  type Pagination,
  type TraktOptions,
  TraktResponseError,
  traktGet,
} from "./client";
import { archiveTraktPage } from "./raw";
import { normalizeHistory, normalizeRatings, type TraktRowsChanged } from "./rows";
import { type HistoryItem, historyPage, type RatingItem, ratingsPage } from "./schema";

export interface TraktSyncOptions extends TraktOptions {
  now?: Date;
  // Shared by every run one invocation makes, so the cap spans them all.
  requests: RequestCap;
}

export interface HistoryWindow {
  // What `sync_runs` records and what names the window's prefix in R2.
  key: string;
  startAt: string;
  endAt: string;
  // Null for a pass that repairs a window the watermark already covers.
  through: string | null;
}

// Trakt reads both bounds inclusively and to the instant, so a play exactly on
// a year boundary lands in both years, and upserts on its ID make that free.
export function yearWindow(year: number, now: Date, advances: boolean): HistoryWindow {
  const endAt = `${year + 1}-01-01T00:00:00.000Z`;
  return {
    key: String(year),
    startAt: `${year}-01-01T00:00:00.000Z`,
    endAt,
    through: advances ? syncedThrough(endAt, now) : null,
  };
}

export function watchedWindow(since: string, until: string): HistoryWindow {
  return { key: `watched:${since}..${until}`, startAt: since, endAt: until, through: until };
}

function userPath(env: Env, resource: string): string {
  return `/users/${encodeURIComponent(env.TRAKT_USER)}/${resource}`;
}

// `start_at` and `end_at` filter on `watched_at`, so a play logged today with a
// date in the past falls outside every later incremental window.
export function syncHistoryWindow(
  env: Env,
  window: HistoryWindow,
  options: TraktSyncOptions,
): Promise<SyncResult> {
  return syncPages(env, options, {
    kind: "trakt-history",
    window: window.key,
    path: userPath(env, "history"),
    params: { start_at: window.startAt, end_at: window.endAt, extended: "full" },
    schema: historyPage,
    normalize: normalizeHistory,
    through: () => window.through,
  });
}

// The whole list every time, since it is small and Trakt offers no window on
// it. The watermark records the last full read.
export function syncRatings(env: Env, options: TraktSyncOptions): Promise<SyncResult> {
  return syncPages(env, options, {
    kind: "trakt-ratings",
    window: "all",
    path: userPath(env, "ratings"),
    params: { extended: "full" },
    schema: ratingsPage,
    normalize: normalizeRatings,
    through: (fetchedAt) => fetchedAt,
  });
}

interface PagedFetch<Item> {
  kind: TraktKind;
  window: string;
  path: string;
  params: Record<string, string>;
  schema: z.ZodType<Item[]>;
  normalize: (db: D1Database, items: Item[], fetchedAt: string) => Promise<TraktRowsChanged>;
  through: (fetchedAt: string) => string | null;
}

async function syncPages<Item extends HistoryItem | RatingItem>(
  env: Env,
  options: TraktSyncOptions,
  fetch: PagedFetch<Item>,
): Promise<SyncResult> {
  const { kind, window } = fetch;

  return recordRun(
    env,
    kind,
    window,
    options,
    async (run) => {
      const pages = traktPages(
        env.TRAKT_CLIENT_ID,
        fetch.path,
        fetch.params,
        fetch.schema,
        options,
      );

      // Each page is archived before its rows are written, so a normalization
      // bug stays diagnosable against the bytes.
      for await (const { number, body, pagination, items } of pages) {
        await archiveTraktPage(env.RAW, {
          kind,
          window,
          fetchedAt: run.fetchedAt,
          page: number,
          body,
          status: 200,
          pagination,
        });
        const changed = await fetch.normalize(env.DB, items, run.fetchedAt);
        run.result = {
          ...run.result,
          pages: number,
          rowsChanged: run.result.rowsChanged + changed.titles + changed.plays + changed.ratings,
        };
      }

      const through = fetch.through(run.fetchedAt);
      if (through !== null) {
        await advance(env.DB, kind, through);
      }
    },
    // A failure carrying bytes lands as the page the fetch never got to.
    async (error, run) => {
      if (error instanceof TraktResponseError) {
        await archiveTraktPage(env.RAW, {
          kind,
          window,
          fetchedAt: run.fetchedAt,
          page: run.result.pages + 1,
          body: error.body,
          status: error.status,
          failure: error.name,
          pagination: null,
        });
      }
    },
  );
}

export interface TraktPage<Item> {
  number: number;
  body: string;
  pagination: Pagination | null;
  items: Item[];
}

// Pages until the count Trakt reports, read off each response rather than
// computed from the requested `limit`, which Trakt may clamp. An endpoint that
// answers without pagination headers answered in full.
export async function* traktPages<Item>(
  clientId: string,
  path: string,
  params: Record<string, string>,
  schema: z.ZodType<Item[]>,
  options: TraktOptions,
): AsyncGenerator<TraktPage<Item>> {
  let number = 1;
  let pageCount: number;
  do {
    // oxlint-disable-next-line no-await-in-loop -- a page lands before the next is requested, so the cap stops between pages
    const response = await traktGet(
      clientId,
      path,
      { ...params, page: String(number), limit: String(PAGE_LIMIT) },
      schema,
      options,
    );
    yield { number, body: response.body, pagination: response.pagination, items: response.data };
    pageCount = response.pagination?.pageCount ?? number;
    number += 1;
  } while (number <= pageCount);
}
