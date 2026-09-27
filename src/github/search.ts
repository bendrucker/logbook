import type { z } from "zod";
import type { GraphQLOptions } from "./client";
import { cursorPages } from "./pages";
import { ISSUE_SEARCH, PULL_REQUEST_SEARCH, REVIEWED_PULL_REQUEST_SEARCH } from "./queries";
import { followReviews, type ReviewsFailure, type ReviewsPage } from "./reviews";
import {
  issueSearchPage,
  pullRequestSearchPage,
  reviewedPullRequestSearchPage,
  type IssueNode,
  type PullRequestNode,
  type RateLimit,
  type ReviewedPullRequestNode,
  reviewsTruncated,
  type SearchPage,
} from "./schema";

export const SEARCH_PAGE_SIZE = 100;

// The search connection returns at most 1,000 results, but `issueCount` still
// reports everything the query matched. A window counting more than the cap has
// lost the rest, and one counting exactly the cap is complete.
export const SEARCH_MAX_RESULTS = 1000;

export function searchTruncated(issueCount: number): boolean {
  return issueCount > SEARCH_MAX_RESULTS;
}

export const SEARCH_MAX_PAGES = SEARCH_MAX_RESULTS / SEARCH_PAGE_SIZE;

export interface SearchPageResult<T> {
  page: number;
  nodes: T[];
  issueCount: number;
  truncated: boolean;
  rateLimit: RateLimit;
  body: string;
  // Follow-up responses that read a pull request's reviews past its nested
  // page. Empty for every kind but the reviewed-PR search.
  reviewPages: ReviewsPage[];
  // A follow-up that failed partway through the page. The pager yields the
  // page with what it read and throws the failure's error after it.
  failure: ReviewsFailure | null;
}

export interface SearchOptions extends GraphQLOptions {
  token: string;
  searchQuery: string;
}

interface DocumentOptions<T> extends SearchOptions {
  document: string;
  schema: z.ZodType<SearchPage<T>>;
  variables?: Record<string, unknown>;
}

async function* searchPages<T>(options: DocumentOptions<T>): AsyncGenerator<SearchPageResult<T>> {
  // The page bound is a stop of its own: GitHub rejects a cursor past the
  // 1,000th result, so a window that keeps announcing successors ends here
  // rather than on that error.
  const pages = cursorPages({
    ...options,
    variables: { ...options.variables, searchQuery: options.searchQuery },
    pageInfo: (data) => data.search.pageInfo,
    pageSize: SEARCH_PAGE_SIZE,
    maxPages: SEARCH_MAX_PAGES,
  });

  for await (const { page, data, rateLimit, body } of pages) {
    const { search } = data;
    yield {
      page,
      nodes: search.nodes,
      issueCount: search.issueCount,
      truncated: searchTruncated(search.issueCount),
      rateLimit,
      body,
      reviewPages: [],
      failure: null,
    };
  }
}

export function pullRequestPages(
  options: SearchOptions,
): AsyncGenerator<SearchPageResult<PullRequestNode>> {
  return searchPages({ ...options, document: PULL_REQUEST_SEARCH, schema: pullRequestSearchPage });
}

// A `reviewed-by:` document filters the reviews sub-connection by author, so the
// login is part of the query rather than only of the search string. Taking it
// as a required field is what keeps a caller from sending the document without
// the variable it declares.
export async function* reviewedPullRequestPages(
  options: SearchOptions & { login: string },
): AsyncGenerator<SearchPageResult<ReviewedPullRequestNode>> {
  const pages = searchPages({
    ...options,
    document: REVIEWED_PULL_REQUEST_SEARCH,
    schema: reviewedPullRequestSearchPage,
    variables: { login: options.login },
  });

  for await (const result of pages) {
    // Each page's follow-ups finish before the next page is requested, so the
    // budget sees their cost before it admits the search's next page.
    // ast-grep-ignore: await-in-for-of
    const followed = await followPage(result, options);
    // The page goes out before the failure does, so the search page and the
    // follow-ups read before it are archived and normalized rather than lost
    // with the request that failed.
    yield followed;
    if (followed.failure !== null) {
      throw followed.failure.error;
    }
  }
}

async function followPage(
  result: SearchPageResult<ReviewedPullRequestNode>,
  options: SearchOptions & { login: string },
): Promise<SearchPageResult<ReviewedPullRequestNode>> {
  const nodes: ReviewedPullRequestNode[] = [];
  const reviewPages: ReviewsPage[] = [];
  let failure: ReviewsFailure | null = null;
  // One pull request at a time, so the budget sees each follow-up's cost
  // before it admits the next. A failure leaves the pull requests after it with
  // only their nested pages.
  const pending = [...result.nodes];
  let node = pending.shift();
  while (node !== undefined) {
    if (failure !== null) {
      nodes.push(node);
    } else {
      // eslint-disable-next-line no-await-in-loop
      const followed = await followReviews(node, options);
      nodes.push(followed.node);
      reviewPages.push(...followed.pages);
      ({ failure } = followed);
    }
    node = pending.shift();
  }

  return {
    ...result,
    nodes,
    truncated: result.truncated || nodes.some(reviewsTruncated),
    reviewPages,
    failure,
  };
}

export function issuePages(options: SearchOptions): AsyncGenerator<SearchPageResult<IssueNode>> {
  return searchPages({ ...options, document: ISSUE_SEARCH, schema: issueSearchPage });
}
