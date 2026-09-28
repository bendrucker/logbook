import { contributionsWindow } from "../github/calendar";
import { GitHubResponseError } from "../github/client";
import {
  type ContributionEventsOptions,
  issueContributionPages,
  pullRequestContributionPages,
  reviewContributionPages,
} from "../github/contribution-events";
import { archiveContributionEventsPage } from "../github/raw";
import type { EventKind } from "../github/windows";
import { normalizeContributionEvents } from "../normalize";
import { CONTRIBUTION_EVENTS, type ContributionEventsKind } from "./kinds";
import {
  charged,
  CLEAN,
  describe,
  githubToken,
  kinded,
  type Page,
  stoppedUntil,
  type SyncOptions,
  type SyncResult,
  total,
} from "./run";
import { finishRun, type RunResult, startRun } from "./runs";

// One crawl unit of a contribution connection: the window read to the end of
// its cursor, each page archived before its rows are written. The connections
// run only as frontier units and leave the watermarks alone, since the
// incremental sync finds changed events through search.
export async function syncContributionEventsWindow(
  env: Env,
  kind: ContributionEventsKind,
  key: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const event = CONTRIBUTION_EVENTS[kind];
  const id = await startRun(env.DB, kind, key, fetchedAt);
  const spent = options.budget.spent;
  let result = CLEAN;
  let resumeAt: string | null = null;

  try {
    const pages = contributionEventPages(event, {
      ...options,
      token: githubToken(env),
      login: env.GITHUB_LOGIN,
      window: contributionsWindow(key, now),
    });

    let page = await pages.next();
    while (page.done !== true) {
      // eslint-disable-next-line no-await-in-loop
      result = await ingest(env, event, key, fetchedAt, page.value, result);
      // eslint-disable-next-line no-await-in-loop
      page = await pages.next();
    }
  } catch (error) {
    result = { ...result, error: describe(error) };
    resumeAt = stoppedUntil(error, now);
    // The page it would have been is the next one the window never got to.
    if (error instanceof GitHubResponseError) {
      await archiveContributionEventsPage(env.RAW, {
        kind: event,
        window: key,
        fetchedAt,
        page: result.pages + 1,
        body: error.body,
      });
    }
  } finally {
    result = charged(result, options.budget, spent);
    await finishRun(env.DB, id, result);
  }

  return { ...result, fetchedAt, resumeAt };
}

async function ingest(
  env: Env,
  kind: EventKind,
  window: string,
  fetchedAt: string,
  page: Page,
  result: RunResult,
): Promise<RunResult> {
  await archiveContributionEventsPage(env.RAW, {
    kind,
    window,
    fetchedAt,
    page: page.page,
    body: page.body,
  });
  const changed = await normalizeContributionEvents(
    env.DB,
    page.nodes,
    env.GITHUB_LOGIN,
    fetchedAt,
  );

  return {
    ...result,
    pages: page.page,
    rowsChanged: result.rowsChanged + total(changed),
    truncated: result.truncated || page.truncated,
  };
}

function contributionEventPages(
  kind: EventKind,
  options: ContributionEventsOptions,
): AsyncGenerator<Page> {
  switch (kind) {
    case "pr-authored":
      return kinded(pullRequestContributionPages(options), (nodes) => ({ kind, nodes }));
    case "pr-reviewed":
      return kinded(reviewContributionPages(options), (nodes) => ({ kind, nodes }));
    case "issue":
      return kinded(issueContributionPages(options), (nodes) => ({ kind, nodes }));
  }
}
