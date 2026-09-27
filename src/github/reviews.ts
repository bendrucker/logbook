import type { GraphQLOptions } from "./client";
import { cursorPages } from "./pages";
import { PULL_REQUEST_REVIEWS } from "./queries";
import {
  pullRequestReviewsPage,
  type PullRequestReviewsPage,
  type ReviewedPullRequestNode,
} from "./schema";

const REVIEWS_PAGE_SIZE = 100;

// One login's reviews on one pull request. A thousand is far past any real
// one, so the bound only stops a connection that keeps announcing successors.
const REVIEWS_MAX_PAGES = 10;

// A follow-up response, archived beside the search page whose pull request it
// completes.
export interface ReviewsPage {
  pullRequest: string;
  page: number;
  body: string;
}

export interface FollowedReviews {
  node: ReviewedPullRequestNode;
  pages: ReviewsPage[];
}

export interface FollowReviewsOptions extends GraphQLOptions {
  token: string;
  login: string;
}

// Reads the reviews a pull request's nested page announced past its end. No
// pull request comes near a hundred reviews by one login, so this almost never
// sends a request.
export async function followReviews(
  node: ReviewedPullRequestNode,
  options: FollowReviewsOptions,
): Promise<FollowedReviews> {
  const pageInfo = node.reviews.pageInfo;
  if (pageInfo?.hasNextPage !== true) {
    return { node, pages: [] };
  }

  const pages = cursorPages({
    ...options,
    document: PULL_REQUEST_REVIEWS,
    variables: { id: node.id, login: options.login },
    schema: pullRequestReviewsPage,
    pageInfo: (data) => data.node?.reviews.pageInfo ?? { hasNextPage: false },
    pageSize: REVIEWS_PAGE_SIZE,
    maxPages: REVIEWS_MAX_PAGES,
    after: pageInfo.endCursor,
  });

  const read: PullRequestReviewsPage[] = [];
  const archived: ReviewsPage[] = [];
  for await (const { page, data, body } of pages) {
    read.push(data);
    archived.push({ pullRequest: node.id, page, body });
  }

  return { node: withReviews(node, read), pages: archived };
}

// The pull request with the follow-up pages' reviews appended, which is how
// both the live sync and replay see it. The count stays the nested page's, so
// `reviewsTruncated` still flags one the follow-up left short.
export function withReviews(
  node: ReviewedPullRequestNode,
  pages: readonly PullRequestReviewsPage[],
): ReviewedPullRequestNode {
  const more = pages.flatMap((page) => page.node?.reviews.nodes ?? []);
  if (more.length === 0) {
    return node;
  }
  return { ...node, reviews: { ...node.reviews, nodes: [...node.reviews.nodes, ...more] } };
}
