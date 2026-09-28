import { GitHubResponseError, type GraphQLOptions, SecondaryRateLimited } from "../github/client";
import {
  type ContributionsWindow,
  contributionsWindow,
  enclosingDay,
  splitContributions,
  windowYear,
  yearWindow,
} from "../github/calendar";
import { type ContributionsResult, fetchContributions } from "../github/contributions";
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
  replayContributions,
  type RowsChanged,
  type SearchPageNodes,
} from "../normalize";
import { type Budget, BudgetRefused, type Clock } from "./budget";
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

// What a backfill or the cron takes. Each opens its own budget.
export interface InvocationOptions extends GraphQLOptions {
  now?: Date;
  clock?: Clock;
}

export interface SyncOptions extends GraphQLOptions {
  now?: Date;
  // Shared by every window one invocation syncs, so the cap spans them all.
  budget: Budget;
}

export interface SyncResult extends RunResult {
  // When the run started, which names its pages in R2.
  fetchedAt: string;
  // Set when the run stopped on the rate budget or a secondary limit rather
  // than a fault: the instant worth waiting for. The limit belongs to the token
  // rather than to this window, so a caller holding more windows stops instead
  // of spending each one's first request rediscovering it.
  resumeAt: string | null;
}

const CLEAN: RunResult = {
  pages: 0,
  rowsChanged: 0,
  truncated: false,
  error: null,
  note: null,
  cost: 0,
  rateRemaining: null,
};

export async function syncWindow(
  env: Env,
  kind: EventKind,
  window: SearchWindow,
  options: SyncOptions,
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const id = await startRun(env.DB, kind, window.key, fetchedAt);
  const spent = options.budget.spent;
  let result = CLEAN;
  let resumeAt: string | null = null;

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
    resumeAt = stoppedUntil(error, now);
    await archiveFailure(env.RAW, kind, window, fetchedAt, result.pages + 1, error);
  } finally {
    result = charged(result, options.budget, spent);
    await finishRun(env.DB, id, result);
  }

  return { ...result, fetchedAt, resumeAt };
}

// The hourly run's current year. A truncated window is fetched again a
// narrower window at a time, down the calendar until each one comes back whole,
// which recovers the days a busy repository's yearly page dropped.
export function syncContributions(
  env: Env,
  year: number,
  options: SyncOptions,
): Promise<SyncResult> {
  return runContributions(env, yearWindow(year, options.now ?? new Date()), options, true);
}

// One crawl unit: the window alone, leaving its split to the frontier.
export function syncContributionsWindow(
  env: Env,
  key: string,
  options: SyncOptions,
): Promise<SyncResult> {
  return runContributions(env, contributionsWindow(key, options.now ?? new Date()), options, false);
}

async function runContributions(
  env: Env,
  root: ContributionsWindow,
  options: SyncOptions,
  walk: boolean,
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const id = await startRun(env.DB, "contributions", root.key, fetchedAt);
  const spent = options.budget.spent;
  let result = CLEAN;
  let resumeAt: string | null = null;
  let current = root;

  try {
    const token = githubToken(env);
    const fetched = await fetchContributions(token, env.GITHUB_LOGIN, root, options);
    result = await ingestContributions(env, fetchedAt, fetched, result);

    // The narrower windows run in turn so the rate budget stops the walk, and
    // the root stays truncated until every one has landed. Depth first, so a
    // window's children run before its next sibling.
    if (walk && fetched.truncated) {
      const pending = splitContributions(root.key, now);
      let irreducible = false;
      let window = pending.shift();
      while (window !== undefined) {
        current = window;
        // eslint-disable-next-line no-await-in-loop
        const part = await fetchContributions(token, env.GITHUB_LOGIN, window, options);
        // eslint-disable-next-line no-await-in-loop
        result = await ingestContributions(env, fetchedAt, part, result);
        if (part.truncated) {
          const children = splitContributions(window.key, now);
          irreducible ||= children.length === 0;
          pending.unshift(...children);
        }
        window = pending.shift();
      }
      result = { ...result, truncated: irreducible };
    }

    const year = windowYear(root.key);
    if (year !== null) {
      result = { ...result, note: await note(env.DB, year, fetched.collection) };
    }
    // A crawl unit that came back truncated leaves its narrower windows to the
    // frontier, so nothing under it is synced until they land. One that cannot
    // narrow further is as synced as it gets.
    const settled = walk || !fetched.truncated || splitContributions(root.key, now).length === 0;
    if (settled) {
      await advance(env.DB, "contributions", syncedThrough(root.to.toISOString(), now));
    }
  } catch (error) {
    result = { ...result, error: describe(error) };
    resumeAt = stoppedUntil(error, now);
    if (error instanceof GitHubResponseError) {
      await archiveContributions(env.RAW, { window: current.key, fetchedAt, body: error.body });
    }
  } finally {
    result = charged(result, options.budget, spent);
    await finishRun(env.DB, id, result);
  }

  return { ...result, fetchedAt, resumeAt };
}

// The budget spans the invocation, so a run's cost is what it spent from the
// point the run started.
function charged(result: RunResult, budget: Budget, before: number): RunResult {
  const cost = budget.spent - before;
  return { ...result, cost, rateRemaining: cost > 0 ? budget.remaining : null };
}

// The cap has no reset to wait for, so a run it stopped resumes as soon as the
// caller likes.
function stoppedUntil(error: unknown, now: Date): string | null {
  if (error instanceof BudgetRefused) {
    return error.resetAt ?? now.toISOString();
  }
  if (error instanceof SecondaryRateLimited) {
    return new Date(now.getTime() + error.retryAfterSeconds * 1000).toISOString();
  }
  return null;
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
  const rows = await contributionRowsChanged(env, fetched, fetchedAt);

  return {
    ...result,
    pages: result.pages + 1,
    rowsChanged: result.rowsChanged + total(rows),
    truncated: result.truncated || fetched.truncated,
  };
}

// A window narrower than a day counts part of each day's commits, so its rows
// are the day's total across every part archived so far rather than its own.
async function contributionRowsChanged(
  env: Env,
  fetched: ContributionsResult,
  fetchedAt: string,
): Promise<RowsChanged> {
  const day = enclosingDay(fetched.window.key);
  if (day === null) {
    return normalizeContributions(env.DB, fetched.collection, fetchedAt);
  }
  const replayed = await replayContributions(env.DB, env.RAW, day);
  return replayed?.rows ?? (await normalizeContributions(env.DB, fetched.collection, fetchedAt));
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
