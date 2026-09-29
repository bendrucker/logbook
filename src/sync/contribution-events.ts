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
import { unhandled } from "../unhandled";
import { CONTRIBUTION_EVENTS, type ContributionEventsKind } from "./kinds";
import {
  githubToken,
  kinded,
  type Page,
  recordRun,
  type SyncOptions,
  type SyncResult,
  total,
} from "./run";
import type { RunResult } from "./runs";

// One crawl unit of a contribution connection: the window read to the end of
// its cursor, each page archived before its rows are written. The connections
// run only as frontier units and leave the watermarks alone, since the
// incremental sync finds changed events through search.
export function syncContributionEventsWindow(
  env: Env,
  kind: ContributionEventsKind,
  key: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const event = CONTRIBUTION_EVENTS[kind];

  return recordRun(
    env,
    kind,
    key,
    options,
    async (run) => {
      const pages = contributionEventPages(event, {
        ...options,
        token: githubToken(env),
        login: env.GITHUB_LOGIN,
        window: contributionsWindow(key, run.now),
      });

      let page = await pages.next();
      while (page.done !== true) {
        // oxlint-disable-next-line no-await-in-loop -- a page lands before the next is requested
        run.result = await ingest(env, event, key, run.fetchedAt, page.value, run.result);
        // oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
        page = await pages.next();
      }
    },
    // The page it would have been is the next one the window never got to.
    async (error, run) => {
      if (error instanceof GitHubResponseError) {
        await archiveContributionEventsPage(env.RAW, {
          kind: event,
          window: key,
          fetchedAt: run.fetchedAt,
          page: run.result.pages + 1,
          body: error.body,
        });
      }
    },
  );
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
    default:
      throw unhandled(kind);
  }
}
