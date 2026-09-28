import type { z } from "zod";
import type { GraphQLOptions } from "./client";
import { cursorPages } from "./pages";
import { ISSUE_SEARCH, PULL_REQUEST_SEARCH, REVIEWED_PULL_REQUEST_SEARCH } from "./queries";
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
}

export interface SearchOptions extends GraphQLOptions {
  token: string;
  searchQuery: string;
}

interface DocumentOptions<T> extends SearchOptions {
  document: string;
  schema: z.ZodType<SearchPage<T>>;
  variables?: Record<string, unknown>;
  // Whether a node lost part of a nested connection, which the page's own
  // count cannot see.
  nodeTruncated?: (node: T) => boolean;
}

async function* searchPages<T>(options: DocumentOptions<T>): AsyncGenerator<SearchPageResult<T>> {
  const nodeTruncated = options.nodeTruncated ?? (() => false);

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
      truncated: searchTruncated(search.issueCount) || search.nodes.some(nodeTruncated),
      rateLimit,
      body,
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
export function reviewedPullRequestPages(
  options: SearchOptions & { login: string },
): AsyncGenerator<SearchPageResult<ReviewedPullRequestNode>> {
  return searchPages({
    ...options,
    document: REVIEWED_PULL_REQUEST_SEARCH,
    schema: reviewedPullRequestSearchPage,
    variables: { login: options.login },
    nodeTruncated: reviewsTruncated,
  });
}

export function issuePages(options: SearchOptions): AsyncGenerator<SearchPageResult<IssueNode>> {
  return searchPages({ ...options, document: ISSUE_SEARCH, schema: issueSearchPage });
}
