// Runtime shapes for the documents in `queries.ts`.
import { z } from "zod";

export const rateLimit = z.object({
  cost: z.number(),
  remaining: z.number(),
  resetAt: z.string(),
});

export type RateLimit = z.infer<typeof rateLimit>;

// Every document selects `rateLimit`, so the budget reads off any response
// without knowing which query produced it.
export const rateLimitResponse = z.object({ rateLimit });

// A connection's `nodes` is nullable, and so is every entry in it. Callers
// only ever iterate, so both collapse to a plain list here.
function nodes<T extends z.ZodType>(node: T) {
  return z
    .array(node.nullable())
    .nullish()
    .transform((entries) => (entries ?? []).filter((entry) => entry !== null));
}

const repository = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  description: z.string().nullable(),
  url: z.string(),
  stargazerCount: z.number(),
  primaryLanguage: z.object({ name: z.string(), color: z.string().nullable() }).nullable(),
  createdAt: z.string(),
  isFork: z.boolean(),
  visibility: z.enum(["PUBLIC", "PRIVATE", "INTERNAL"]),
});

export type Repository = z.infer<typeof repository>;

// An author is null once the account is deleted.
const author = z.object({ login: z.string() }).nullable();

// A page announcing a successor has to carry the cursor that reaches it.
// Pairing the two fields keeps a response that sets one without the other from
// sending the paginator back to the first page for as long as it keeps going.
const pageInfo = z.discriminatedUnion("hasNextPage", [
  z.object({ hasNextPage: z.literal(false) }),
  z.object({ hasNextPage: z.literal(true), endCursor: z.string() }),
]);

export type PageInfo = z.infer<typeof pageInfo>;

export interface SearchPage<T> {
  search: {
    issueCount: number;
    pageInfo: PageInfo;
    nodes: T[];
  };
}

// `search` returns whatever matched, so a node of another type is dropped on
// its `__typename` before the shape is checked. Discarding by type first is
// what keeps a renamed field an error here rather than a silently empty page.
function searchPage<T extends z.ZodObject<{ __typename: z.ZodLiteral<string> }>>(node: T) {
  const typename = node.shape.__typename.value;
  return z.object({
    search: z.object({
      issueCount: z.number(),
      pageInfo,
      nodes: nodes(z.looseObject({ __typename: z.string() }))
        .transform((entries) => entries.filter((entry) => entry.__typename === typename))
        .pipe(z.array(node)),
    }),
  });
}

const pullRequestNode = z.object({
  __typename: z.literal("PullRequest"),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  author,
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  comments: z.object({ totalCount: z.number() }),
  reviews: z.object({ totalCount: z.number() }),
  updatedAt: z.string(),
  repository,
});

export type PullRequestNode = z.infer<typeof pullRequestNode>;

const review = z.object({
  id: z.string(),
  state: z.enum(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]),
  // Null until the review is submitted.
  submittedAt: z.string().nullable(),
});

// A `reviewed-by:` search matches the pull request rather than the review, so
// the reviews themselves come off a sub-connection filtered to one author.
const reviewedPullRequestNode = z.object({
  __typename: z.literal("PullRequest"),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  author,
  updatedAt: z.string(),
  reviews: z.object({ totalCount: z.number(), nodes: nodes(review) }),
  repository,
});

export type ReviewedPullRequestNode = z.infer<typeof reviewedPullRequestNode>;

// The reviews sub-connection returns one page and carries no cursor the outer
// paginator could follow, so a pull request with more reviews than that page
// holds has lost the rest. `nodes()` drops null entries, which can only make a
// complete page read as short: the check errs toward flagging.
export function reviewsTruncated(node: ReviewedPullRequestNode): boolean {
  return node.reviews.totalCount > node.reviews.nodes.length;
}

const issueNode = z.object({
  __typename: z.literal("Issue"),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  author,
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED"]),
  comments: z.object({ totalCount: z.number() }),
  updatedAt: z.string(),
  repository,
});

export type IssueNode = z.infer<typeof issueNode>;

export const pullRequestSearchPage = searchPage(pullRequestNode);
export const reviewedPullRequestSearchPage = searchPage(reviewedPullRequestNode);
export const issueSearchPage = searchPage(issueNode);

const contributionsCollection = z.object({
  totalCommitContributions: z.number(),
  totalPullRequestContributions: z.number(),
  totalPullRequestReviewContributions: z.number(),
  totalIssueContributions: z.number(),
  totalRepositoriesWithContributedCommits: z.number(),
  restrictedContributionsCount: z.number(),
  contributionYears: z.array(z.number()),
  commitContributionsByRepository: z.array(
    z.object({
      repository,
      contributions: z.object({
        totalCount: z.number(),
        nodes: nodes(z.object({ commitCount: z.number(), occurredAt: z.string() })),
      }),
    }),
  ),
});

export type ContributionsCollection = z.infer<typeof contributionsCollection>;

export const contributionsResponse = z.object({
  user: z.object({ contributionsCollection }).nullable(),
});
