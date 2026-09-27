import { GitHubResponseError, type GraphQLOptions, RateLimitExhausted } from "../github/client";
import {
  type ContributionsResult,
  fetchContributions,
  quarterWindows,
  yearWindow,
} from "../github/contributions";
import { archiveContributions, archiveSearchPage } from "../github/raw";
import {
  issuePages,
  pullRequestPages,
  reviewedPullRequestPages,
  type SearchPageResult,
} from "../github/search";
import type { ContributionsCollection } from "../github/schema";
import type { EventKind } from "../github/windows";
import {
  normalizeContributions,
  normalizeSearchPage,
  type RowsChanged,
  type SearchPageNodes,
} from "../normalize";
import { crossCheck } from "./cross-check";
import { finishRun, type RunResult, startRun } from "./runs";
import { advance } from "./state";

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`${name} is not configured`);
    this.name = "MissingSecretError";
  }
}

export function githubToken(env: Env): string {
  const token = env.GITHUB_TOKEN;
  if (token === undefined || token === "") {
    throw new MissingSecretError("GITHUB_TOKEN");
  }
  return token;
}

export interface SearchWindow {
  // What `sync_runs` records and what names the window's prefix in R2: a month
  // key for a backfill, the anchor instant for an incremental window.
  key: string;
  query: string;
  // The instant the window leaves synced. The watermark takes it once every
  // page is in R2 and every row is in D1.
  through: string;
}

export interface SyncOptions extends GraphQLOptions {
  now?: Date;
}

export interface SyncResult extends RunResult {
  // The budget belongs to the token rather than to this window, so a caller
  // holding more windows stops instead of spending each one's first request
  // rediscovering the floor.
  exhausted: boolean;
}

const CLEAN: RunResult = {
  pages: 0,
  rowsChanged: 0,
  truncated: false,
  error: null,
  note: null,
};

export async function syncWindow(
  env: Env,
  kind: EventKind,
  window: SearchWindow,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const id = await startRun(env.DB, kind, window.key, fetchedAt);
  let result = CLEAN;
  let exhausted = false;

  try {
    const pages = searchPages(kind, {
      ...options,
      token: githubToken(env),
      login: env.GITHUB_LOGIN,
      searchQuery: window.query,
    });

    // The pages arrive one at a time because each request needs the cursor the
    // response before it returned, and each one is archived before its rows are
    // written so a normalization bug stays diagnosable against the bytes.
    let page = await pages.next();
    while (page.done !== true) {
      // eslint-disable-next-line no-await-in-loop
      result = await ingest(env, kind, window, fetchedAt, page.value, result);
      // eslint-disable-next-line no-await-in-loop
      page = await pages.next();
    }

    // Inside the run so a watermark that fails to move is the run's error
    // rather than an exception out of the cron.
    await advance(env.DB, kind, window.through);
  } catch (error) {
    result = { ...result, error: describe(error) };
    exhausted = error instanceof RateLimitExhausted;
    await archiveFailure(env.RAW, kind, window, fetchedAt, result.pages + 1, error);
  } finally {
    await finishRun(env.DB, id, result);
  }

  return { ...result, exhausted };
}

export interface ContributionsRun extends SyncResult {
  // The years GitHub reports holding contributions for.
  contributionYears: number[];
}

export async function syncContributions(
  env: Env,
  year: number,
  options: SyncOptions = {},
): Promise<ContributionsRun> {
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const id = await startRun(env.DB, "contributions", String(year), fetchedAt);
  let result = CLEAN;
  let exhausted = false;
  let collection: ContributionsCollection | null = null;
  let current = yearWindow(year, now);

  try {
    const token = githubToken(env);
    const fetched = await fetchContributions(token, env.GITHUB_LOGIN, current, options);
    collection = fetched.collection;
    result = await ingestContributions(env, fetchedAt, fetched, result);

    // A truncated year is fetched again a quarter at a time, which recovers the
    // days a busy repository's yearly page dropped. The quarters run in turn so
    // the rate-limit floor stops the walk, and the year stays truncated until
    // every quarter has landed.
    if (fetched.truncated) {
      const quarters = quarterWindows(year, now);
      let quarterTruncated = false;
      let quarter = quarters.shift();
      while (quarter !== undefined) {
        current = quarter;
        // eslint-disable-next-line no-await-in-loop
        const part = await fetchContributions(token, env.GITHUB_LOGIN, quarter, options);
        // eslint-disable-next-line no-await-in-loop
        result = await ingestContributions(env, fetchedAt, part, result);
        quarterTruncated ||= part.truncated;
        quarter = quarters.shift();
      }
      result = { ...result, truncated: quarterTruncated };
    }

    result = { ...result, note: await note(env.DB, year, fetched.collection) };
    await advance(env.DB, "contributions", syncedThrough(yearEnd(year), now));
  } catch (error) {
    result = { ...result, error: describe(error) };
    exhausted = error instanceof RateLimitExhausted;
    if (error instanceof GitHubResponseError) {
      await archiveContributions(env.RAW, { window: current.key, fetchedAt, body: error.body });
    }
  } finally {
    await finishRun(env.DB, id, result);
  }

  return { ...result, exhausted, contributionYears: collection?.contributionYears ?? [] };
}

async function ingestContributions(
  env: Env,
  fetchedAt: string,
  fetched: ContributionsResult,
  result: RunResult,
): Promise<RunResult> {
  await archiveContributions(env.RAW, {
    window: fetched.window.key,
    fetchedAt,
    body: fetched.body,
  });
  const rows = await normalizeContributions(env.DB, fetched.collection, fetchedAt);

  return {
    ...result,
    pages: result.pages + 1,
    rowsChanged: result.rowsChanged + total(rows),
    truncated: result.truncated || fetched.truncated,
  };
}

// The cross-check reports on a run whose pages are already in R2 and whose rows
// are already in D1, so a failure to compute it is something to read rather
// than the run's error.
async function note(
  db: D1Database,
  year: number,
  collection: ContributionsCollection,
): Promise<string | null> {
  try {
    return await crossCheck(db, year, collection);
  } catch (error) {
    return `${year} cross-check failed: ${describe(error)}`;
  }
}

// A window still in progress closes in the future. The watermark takes the
// earlier instant, because a future one outranks every later advance the
// monotonic guard sees and freezes the kind until the calendar catches up.
export function syncedThrough(end: string, now: Date): string {
  const at = now.toISOString();
  return end < at ? end : at;
}

// The collection takes at most a year per request, so a year is synced no
// further than its own last instant.
function yearEnd(year: number): string {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();
}

interface Page {
  page: number;
  body: string;
  truncated: boolean;
  nodes: SearchPageNodes;
}

async function ingest(
  env: Env,
  kind: EventKind,
  window: SearchWindow,
  fetchedAt: string,
  page: Page,
  result: RunResult,
): Promise<RunResult> {
  await archiveSearchPage(env.RAW, {
    kind,
    window: window.key,
    fetchedAt,
    page: page.page,
    body: page.body,
  });
  const changed = await normalizeSearchPage(env.DB, page.nodes, fetchedAt);

  return {
    ...result,
    pages: page.page,
    rowsChanged: result.rowsChanged + total(changed),
    truncated: result.truncated || page.truncated,
  };
}

// Every failure carrying bytes carries the ones that broke the run, and the
// page it would have been is the next one the window never got to.
function archiveFailure(
  bucket: R2Bucket,
  kind: EventKind,
  window: SearchWindow,
  fetchedAt: string,
  page: number,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof GitHubResponseError)) {
    return Promise.resolve(null);
  }
  return archiveSearchPage(bucket, { kind, window: window.key, fetchedAt, page, body: error.body });
}

interface PagerOptions extends GraphQLOptions {
  token: string;
  login: string;
  searchQuery: string;
}

// One switch on the kind, so the nodes a pager yields keep the tie to the kind
// that produced them and `normalizeSearchPage` needs no cast to recover it.
function searchPages(kind: EventKind, options: PagerOptions): AsyncGenerator<Page> {
  switch (kind) {
    case "pr-authored":
      return kinded(pullRequestPages(options), (nodes) => ({ kind, nodes }));
    case "pr-reviewed":
      return kinded(reviewedPullRequestPages(options), (nodes) => ({ kind, nodes }));
    case "issue":
      return kinded(issuePages(options), (nodes) => ({ kind, nodes }));
  }
}

async function* kinded<Node>(
  source: AsyncGenerator<SearchPageResult<Node>>,
  toNodes: (nodes: Node[]) => SearchPageNodes,
): AsyncGenerator<Page> {
  for await (const result of source) {
    yield {
      page: result.page,
      body: result.body,
      truncated: result.truncated,
      nodes: toNodes(result.nodes),
    };
  }
}

function total(changed: RowsChanged): number {
  return Object.values(changed).reduce((sum, count) => sum + count, 0);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
