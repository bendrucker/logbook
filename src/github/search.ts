import type { z } from "zod";
import { GitHubResponseError, graphql, validate, type GraphQLOptions } from "./client";
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

// A page announcing a successor whose cursor the pager already sent would serve
// the same results again for as long as it kept following it. The page is
// thrown rather than yielded so the window fails with its bytes archived and
// its watermark where it was.
export class RepeatedCursorError extends GitHubResponseError {
  readonly cursor: string;

  constructor(cursor: string, body: string) {
    super("RepeatedCursorError", `GitHub search returned cursor ${cursor} again`, body);
    this.cursor = cursor;
  }
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
  let after: string | null = null;
  const sent = new Set<string>();
  const nodeTruncated = options.nodeTruncated ?? (() => false);
  let page = 0;
  let remaining = true;

  // A cursor loop rather than for...of: each request depends on the cursor the
  // response before it returned, so the pages cannot be issued together. The
  // page bound is the second stop: GitHub rejects a cursor past the 1,000th
  // result, so a window that keeps announcing successors ends here rather than
  // on that error. A cursor that fails to advance ends it sooner, as an error.
  while (remaining && page < SEARCH_MAX_PAGES) {
    // eslint-disable-next-line no-await-in-loop
    const response = await graphql(
      options.token,
      options.document,
      {
        ...options.variables,
        searchQuery: options.searchQuery,
        first: SEARCH_PAGE_SIZE,
        after,
      },
      options,
    );

    const { search } = validate(options.schema, response.data, response.body);
    if (search.pageInfo.hasNextPage && sent.has(search.pageInfo.endCursor)) {
      throw new RepeatedCursorError(search.pageInfo.endCursor, response.body);
    }
    page += 1;

    yield {
      page,
      nodes: search.nodes,
      issueCount: search.issueCount,
      truncated: searchTruncated(search.issueCount) || search.nodes.some(nodeTruncated),
      rateLimit: response.rateLimit,
      body: response.body,
    };

    remaining = search.pageInfo.hasNextPage;
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
    if (after !== null) {
      sent.add(after);
    }
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
