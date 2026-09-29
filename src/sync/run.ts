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
import { archiveContributions, archiveSearchPage, archiveSearchReviews } from "../github/raw";
import type { ReviewsFailure, ReviewsPage } from "../github/reviews";
import { issuePages, pullRequestPages, reviewedPullRequestPages } from "../github/search";
import type { ContributionsCollection } from "../github/schema";
import type { EventKind } from "../github/windows";
import { InstapaperRateLimited } from "../instapaper/client";
import {
  normalizeContributions,
  normalizeSearchPage,
  replayContributions,
  type RowsChanged,
  type SearchPageNodes,
} from "../normalize";
import { unhandled } from "../unhandled";
import { type Budget, BudgetRefused, type Clock } from "./budget";
import { archivedYear, crossCheck } from "./cross-check";
import { recordIrreducible } from "./frontier";
import type { SyncKind } from "./kinds";
import { finishRun, type RunResult, startRun } from "./runs";
import { RequestCapReached } from "../request-cap";
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
  // What `sync_runs` records and what names the window's prefix in R2: a
  // `created:` window key for a backfill, the `updated:` range for an
  // incremental window.
  key: string;
  query: string;
  // The instant the window leaves synced. The watermark takes it once every
  // page is in R2 and every row is in D1.
  through: string;
  // Nothing under a split window is synced until its children land, so the
  // watermark waits.
  splits: boolean;
}

// Each opens its own budget.
export interface InvocationOptions extends GraphQLOptions {
  now?: Date;
  clock?: Clock;
}

// A source without a point budget records no cost.
export interface RunOptions {
  now?: Date;
  budget?: Budget;
}

export interface SyncOptions extends GraphQLOptions, RunOptions {
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

export const CLEAN: RunResult = {
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
  let followUp: ReviewsFailure | null = null;

  return recordRun(
    env,
    kind,
    window.key,
    options,
    async (run) => {
      const pages = searchPages(kind, {
        ...options,
        token: githubToken(env),
        login: env.GITHUB_LOGIN,
        searchQuery: window.query,
      });

      // The pages arrive one at a time because each request needs the cursor
      // the response before it returned, and each one is archived before its
      // rows are written so a normalization bug stays diagnosable against the
      // bytes.
      let page = await pages.next();
      while (page.done !== true) {
        // oxlint-disable-next-line no-await-in-loop -- a page lands before the next is requested
        run.result = await ingest(env, kind, window, run.fetchedAt, page.value, run.result);
        followUp = page.value.failure;
        // oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
        page = await pages.next();
      }

      // Inside the run so a watermark that fails to move is the run's error
      // rather than an exception out of the cron. A window that cannot narrow
      // further is as synced as it gets.
      if (run.result.truncated && !window.splits) {
        await recordIrreducible(env.DB, kind, [window.key], run.fetchedAt);
      }
      if (!run.result.truncated || !window.splits) {
        await advance(env.DB, kind, window.through);
      }
    },
    (error, run) =>
      archiveFailure(
        env.RAW,
        { kind, window: window.key, fetchedAt: run.fetchedAt },
        run.result,
        followUp,
        error,
      ),
  );
}

export interface Run {
  now: Date;
  // When the run started, which names its pages in R2.
  fetchedAt: string;
  // What the run has landed so far, which a failure keeps.
  result: RunResult;
}

// One `sync_runs` row around `body`: a failure becomes the run's error, and
// the run records what it spent whether or not it finished.
export async function recordRun(
  env: Env,
  kind: SyncKind,
  window: string,
  options: RunOptions,
  body: (run: Run) => Promise<void>,
  onFailure: (error: unknown, run: Run) => Promise<unknown>,
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const run: Run = { now, fetchedAt: now.toISOString(), result: CLEAN };
  const id = await startRun(env.DB, kind, window, run.fetchedAt);
  const { budget } = options;
  const spent = budget?.spent ?? 0;
  let resumeAt: string | null = null;

  try {
    await body(run);
  } catch (error) {
    run.result = { ...run.result, error: describe(error) };
    resumeAt = stoppedUntil(error, now);
    await onFailure(error, run);
  } finally {
    if (budget !== undefined) {
      run.result = charged(run.result, budget, spent);
    }
    await finishRun(env.DB, id, run.result);
  }

  return { ...run.result, fetchedAt: run.fetchedAt, resumeAt };
}

// A truncated window is fetched again a narrower window at a time, down the
// calendar until each one comes back whole, which recovers the days a busy
// repository's yearly page dropped.
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
  let current = root;

  return recordRun(
    env,
    "contributions",
    root.key,
    options,
    async (run) => {
      const { now, fetchedAt } = run;
      const token = githubToken(env);
      const fetched = await fetchContributions(token, env.GITHUB_LOGIN, root, options);
      run.result = await ingestContributions(env, fetchedAt, fetched, run.result);

      // The narrower windows run in turn so the rate budget stops the walk, and
      // the root stays truncated until every one has landed. Depth first, so a
      // window's children run before its next sibling.
      if (walk && fetched.truncated) {
        const pending = splitContributions(root.key, now);
        const irreducible: string[] = [];
        let window = pending.shift();
        while (window !== undefined) {
          current = window;
          // oxlint-disable-next-line no-await-in-loop -- the rate budget stops the walk between windows
          const part = await fetchContributions(token, env.GITHUB_LOGIN, window, options);
          // oxlint-disable-next-line no-await-in-loop -- a window's children depend on whether it came back truncated
          run.result = await ingestContributions(env, fetchedAt, part, run.result);
          if (part.truncated) {
            const children = splitContributions(window.key, now);
            if (children.length === 0) {
              irreducible.push(window.key);
            }
            pending.unshift(...children);
          }
          window = pending.shift();
        }
        await recordIrreducible(env.DB, "contributions", irreducible, fetchedAt);
        run.result = { ...run.result, truncated: irreducible.length > 0 };
      }

      const year = windowYear(root.key);
      if (year !== null) {
        run.result = { ...run.result, note: await note(env, year, fetched.collection) };
      }
      // A crawl unit that came back truncated leaves its narrower windows to
      // the frontier, so nothing under it is synced until they land. One that
      // cannot narrow further is as synced as it gets.
      const settled = walk || !fetched.truncated || splitContributions(root.key, now).length === 0;
      if (settled) {
        await advance(env.DB, "contributions", syncedThrough(root.to.toISOString(), now));
      }
    },
    async (error, run) => {
      if (error instanceof GitHubResponseError) {
        await archiveContributions(env.RAW, {
          window: current.key,
          fetchedAt: run.fetchedAt,
          body: error.body,
        });
      }
    },
  );
}

// The budget spans the invocation, so a run's cost is what it spent from the
// point the run started.
export function charged(result: RunResult, budget: Budget, before: number): RunResult {
  const cost = budget.spent - before;
  return { ...result, cost, rateRemaining: cost > 0 ? budget.remaining : null };
}

// A cap has no reset to wait for, so a run it stopped resumes as soon as the
// caller likes.
export function stoppedUntil(error: unknown, now: Date): string | null {
  if (error instanceof BudgetRefused) {
    return error.resetAt ?? now.toISOString();
  }
  if (error instanceof SecondaryRateLimited || error instanceof InstapaperRateLimited) {
    return new Date(now.getTime() + error.retryAfterSeconds * 1000).toISOString();
  }
  if (error instanceof RequestCapReached) {
    return now.toISOString();
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
  // The window was archived before this, so a replay finding nothing is a
  // listing that missed it. Writing the window's own rows would overwrite the
  // day's total with a part of it.
  const replayed = await replayContributions(env.DB, env.RAW, day);
  if (replayed === null) {
    throw new Error(`${fetched.window.key} is missing from the archive of ${day}`);
  }
  return replayed.rows;
}

// The cross-check reports on a run whose pages are already in R2 and whose rows
// are already in D1, so a failure to compute it is something to read rather
// than the run's error.
async function note(
  env: Env,
  year: number,
  collection: ContributionsCollection,
): Promise<string | null> {
  try {
    const archived = await archivedYear(env.RAW, year, env.GITHUB_LOGIN);
    return await crossCheck(env.DB, year, collection, archived);
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

export interface Page {
  page: number;
  body: string;
  truncated: boolean;
  nodes: SearchPageNodes;
  reviewPages: readonly ReviewsPage[];
  failure: ReviewsFailure | null;
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
  for (const reviews of page.reviewPages) {
    // oxlint-disable-next-line no-await-in-loop -- a failed write leaves the follow-ups before it archived, never a gap
    await archiveSearchReviews(env.RAW, { kind, window: window.key, fetchedAt, ...reviews });
  }
  const changed = await normalizeSearchPage(env.DB, page.nodes, fetchedAt);

  return {
    ...result,
    pages: page.page,
    rowsChanged: result.rowsChanged + total(changed),
    truncated: result.truncated || page.truncated,
  };
}

interface FetchKey {
  kind: EventKind;
  window: string;
  fetchedAt: string;
}

// Every failure carrying bytes carries the ones that broke the run. A review
// follow-up's lands beside the search page it was completing, as the page of
// that pull request's reviews it would have been. Any other failure is the
// next search page the window never got to.
function archiveFailure(
  bucket: R2Bucket,
  fetch: FetchKey,
  result: RunResult,
  followUp: ReviewsFailure | null,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof GitHubResponseError)) {
    return Promise.resolve(null);
  }
  if (followUp?.error === error) {
    const { pullRequest, page } = followUp;
    return archiveSearchReviews(bucket, { ...fetch, pullRequest, page, body: error.body });
  }
  return archiveSearchPage(bucket, { ...fetch, page: result.pages + 1, body: error.body });
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
    default:
      throw unhandled(kind);
  }
}

// What a pager yields, whether it pages a search or a contribution connection.
interface PagerResult<Node> {
  page: number;
  body: string;
  truncated: boolean;
  nodes: Node[];
  reviewPages?: readonly ReviewsPage[];
  failure?: ReviewsFailure | null;
}

export async function* kinded<Node>(
  source: AsyncGenerator<PagerResult<Node>>,
  toNodes: (nodes: Node[]) => SearchPageNodes,
): AsyncGenerator<Page> {
  for await (const result of source) {
    yield {
      page: result.page,
      body: result.body,
      truncated: result.truncated,
      nodes: toNodes(result.nodes),
      reviewPages: result.reviewPages ?? [],
      failure: result.failure ?? null,
    };
  }
}

export function total(changed: RowsChanged): number {
  const counts: Record<keyof RowsChanged, number> = changed;
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
