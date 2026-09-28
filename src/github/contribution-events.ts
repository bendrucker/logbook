import type { z } from "zod";
import type { ContributionsWindow } from "./calendar";
import type { GraphQLOptions } from "./client";
import { UnknownUserError } from "./contributions";
import { cursorPages } from "./pages";
import {
  ISSUE_CONTRIBUTIONS,
  PULL_REQUEST_CONTRIBUTIONS,
  PULL_REQUEST_REVIEW_CONTRIBUTIONS,
} from "./queries";
import {
  type ContributionConnectionPage,
  type IssueNode,
  issueContributionsPage,
  type PullRequestNode,
  pullRequestContributionsPage,
  type RateLimit,
  type ReviewedPullRequestNode,
  reviewContributionsPage,
  reviewsTruncated,
} from "./schema";

export const CONTRIBUTION_EVENTS_PAGE_SIZE = 100;

// A window holding more comes back truncated and the frontier narrows it
// down the calendar, which bounds what a unit interrupted by the budget
// costs to restart.
export const CONTRIBUTION_EVENTS_MAX_PAGES = 10;

export interface ContributionEventsPageResult<T> {
  page: number;
  nodes: T[];
  totalCount: number;
  truncated: boolean;
  rateLimit: RateLimit;
  body: string;
}

export interface ContributionEventsOptions extends GraphQLOptions {
  token: string;
  login: string;
  window: ContributionsWindow;
}

// The connection reports how many contributions it holds, so a fetch whose
// cursor ended having read fewer lost the rest, and one stopped at the page
// bound with a successor still announced lost whatever came after. `nodes()`
// drops null entries, which can only make a complete fetch read as short: the
// check errs toward flagging.
export function contributionEventsTruncated(
  pages: readonly ContributionConnectionPage<unknown>[],
): boolean {
  const last = pages.at(-1);
  if (last === undefined) {
    return true;
  }
  const read = pages.reduce((total, page) => total + page.nodes.length, 0);
  return last.pageInfo.hasNextPage || read < last.totalCount;
}

interface DocumentOptions<T> extends ContributionEventsOptions {
  document: string;
  schema: z.ZodType<ContributionConnectionPage<T> | null>;
  nodeTruncated?: (node: T) => boolean;
}

async function* contributionEventPages<T>(
  options: DocumentOptions<T>,
): AsyncGenerator<ContributionEventsPageResult<T>> {
  const nodeTruncated = options.nodeTruncated ?? (() => false);
  const pages = cursorPages({
    ...options,
    variables: {
      login: options.login,
      from: options.window.from.toISOString(),
      to: options.window.to.toISOString(),
    },
    pageInfo: (data) => data?.pageInfo ?? { hasNextPage: false },
    pageSize: CONTRIBUTION_EVENTS_PAGE_SIZE,
    maxPages: CONTRIBUTION_EVENTS_MAX_PAGES,
  });

  // Only the last page can say whether the connection came back whole, so the
  // earlier pages carry just what their own nodes lost.
  const read: ContributionConnectionPage<T>[] = [];
  for await (const { page, data, rateLimit, body } of pages) {
    if (data === null) {
      throw new UnknownUserError(options.login, body);
    }
    read.push(data);
    const last = !data.pageInfo.hasNextPage || page >= CONTRIBUTION_EVENTS_MAX_PAGES;
    yield {
      page,
      nodes: data.nodes,
      totalCount: data.totalCount,
      truncated: data.nodes.some(nodeTruncated) || (last && contributionEventsTruncated(read)),
      rateLimit,
      body,
    };
  }
}

export function issueContributionPages(
  options: ContributionEventsOptions,
): AsyncGenerator<ContributionEventsPageResult<IssueNode>> {
  return contributionEventPages({
    ...options,
    document: ISSUE_CONTRIBUTIONS,
    schema: issueContributionsPage,
  });
}

export function pullRequestContributionPages(
  options: ContributionEventsOptions,
): AsyncGenerator<ContributionEventsPageResult<PullRequestNode>> {
  return contributionEventPages({
    ...options,
    document: PULL_REQUEST_CONTRIBUTIONS,
    schema: pullRequestContributionsPage,
  });
}

export function reviewContributionPages(
  options: ContributionEventsOptions,
): AsyncGenerator<ContributionEventsPageResult<ReviewedPullRequestNode>> {
  return contributionEventPages({
    ...options,
    document: PULL_REQUEST_REVIEW_CONTRIBUTIONS,
    schema: reviewContributionsPage,
    nodeTruncated: reviewsTruncated,
  });
}
