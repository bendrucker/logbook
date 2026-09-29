import type {
  ContributionsCollection,
  IssueNode,
  PageInfo,
  PullRequestNode,
  RateLimit,
  Repository,
  ReviewedPullRequestNode,
} from "../src/github/schema";

export interface GraphQLPayload<Data> {
  data: Data & { rateLimit: RateLimit };
}

export interface ConnectionPayload {
  totalCount: number;
  pageInfo: PageInfo;
  nodes: readonly unknown[];
}

type CommitDay =
  ContributionsCollection["commitContributionsByRepository"][number]["contributions"]["nodes"][number];

type ContributionsPayload = GraphQLPayload<{
  user: { contributionsCollection: ContributionsCollection };
}>;

export interface RateLimitOverrides {
  cost?: number;
  remaining?: number;
  resetAt?: string;
}

export function rateLimit(overrides: RateLimitOverrides = {}): RateLimit {
  return {
    cost: overrides.cost ?? 1,
    remaining: overrides.remaining ?? 4999,
    resetAt: overrides.resetAt ?? "2026-09-09T11:00:00Z",
  };
}

export function repository(name = "logbook", overrides: Partial<Repository> = {}): Repository {
  return {
    id: `R_${name}`,
    name,
    owner: { login: "bendrucker" },
    description: "System of record for GitHub contribution data",
    url: `https://github.com/bendrucker/${name}`,
    stargazerCount: 3,
    primaryLanguage: { name: "TypeScript", color: "#3178c6" },
    createdAt: "2026-08-01T00:00:00Z",
    isFork: false,
    visibility: "PUBLIC",
    ...overrides,
  };
}

export function pullRequest(
  number: number,
  overrides: Partial<PullRequestNode> = {},
): PullRequestNode {
  return {
    __typename: "PullRequest",
    id: `PR_${number}`,
    number,
    title: `pull request ${number}`,
    author: { login: "bendrucker" },
    createdAt: "2026-08-02T00:00:00Z",
    mergedAt: "2026-08-03T00:00:00Z",
    closedAt: "2026-08-03T00:00:00Z",
    state: "MERGED",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    comments: { totalCount: 1 },
    reviews: { totalCount: 2 },
    updatedAt: "2026-08-03T00:00:00Z",
    repository: repository(),
    ...overrides,
  };
}

type ReviewNode = ReviewedPullRequestNode["reviews"]["nodes"][number];

export function review(number: number, overrides: Partial<ReviewNode> = {}): ReviewNode {
  return {
    id: `PRR_${number}`,
    state: "APPROVED",
    submittedAt: "2026-08-03T00:00:00Z",
    ...overrides,
  };
}

export function reviewedPullRequest(
  number: number,
  overrides: Partial<ReviewedPullRequestNode> = {},
): ReviewedPullRequestNode {
  return {
    __typename: "PullRequest",
    id: `PR_${number}`,
    number,
    title: `pull request ${number}`,
    author: { login: "someone" },
    updatedAt: "2026-08-03T00:00:00Z",
    reviews: { totalCount: 1, nodes: [review(number)] },
    repository: repository(),
    ...overrides,
  };
}

export function issue(number: number, overrides: Partial<IssueNode> = {}): IssueNode {
  return {
    __typename: "Issue",
    id: `I_${number}`,
    number,
    title: `issue ${number}`,
    author: { login: "bendrucker" },
    createdAt: "2026-08-02T00:00:00Z",
    closedAt: null,
    state: "OPEN",
    comments: { totalCount: 0 },
    updatedAt: "2026-08-02T00:00:00Z",
    repository: repository(),
    ...overrides,
  };
}

export interface SearchOverrides {
  issueCount?: number;
  endCursor?: string | null;
}

// The payload is the whole GraphQL response, which is what R2 archives and what
// replay reads back, so a replay test and a fetch stub build from one shape.
export function searchPayload(
  nodes: readonly unknown[],
  overrides: SearchOverrides = {},
): GraphQLPayload<{ search: Omit<ConnectionPayload, "totalCount"> & { issueCount: number } }> {
  const endCursor = overrides.endCursor ?? null;
  return {
    data: {
      search: {
        issueCount: overrides.issueCount ?? nodes.length,
        pageInfo: endCursor === null ? { hasNextPage: false } : { hasNextPage: true, endCursor },
        nodes,
      },
      rateLimit: rateLimit(),
    },
  };
}

export function searchResponse(
  nodes: readonly unknown[],
  overrides: SearchOverrides = {},
): Response {
  return jsonResponse(searchPayload(nodes, overrides));
}

// One page of the follow-up that reads a pull request's reviews past the page
// its search result nested.
export function reviewsPayload(
  nodes: readonly unknown[],
  overrides: { totalCount?: number; endCursor?: string | null } = {},
): GraphQLPayload<{ node: { reviews: ConnectionPayload } }> {
  const endCursor = overrides.endCursor ?? null;
  return {
    data: {
      node: {
        reviews: {
          totalCount: overrides.totalCount ?? nodes.length,
          pageInfo: endCursor === null ? { hasNextPage: false } : { hasNextPage: true, endCursor },
          nodes,
        },
      },
      rateLimit: rateLimit(),
    },
  };
}

export type ContributionEventsField =
  | "issueContributions"
  | "pullRequestContributions"
  | "pullRequestReviewContributions";

export interface ContributionEventsOverrides {
  // The whole connection's count, which a multi-page fixture has to state.
  totalCount?: number;
  endCursor?: string | null;
}

// One page of a contribution connection as GitHub returns it, each node wrapped
// in the contribution object that counts it.
export function contributionEventsPayload(
  field: ContributionEventsField,
  nodes: readonly unknown[],
  overrides: ContributionEventsOverrides = {},
): GraphQLPayload<{
  user: { contributionsCollection: Partial<Record<ContributionEventsField, ConnectionPayload>> };
}> {
  const item = field === "issueContributions" ? "issue" : "pullRequest";
  const endCursor = overrides.endCursor ?? null;
  return {
    data: {
      user: {
        contributionsCollection: {
          [field]: {
            totalCount: overrides.totalCount ?? nodes.length,
            pageInfo:
              endCursor === null ? { hasNextPage: false } : { hasNextPage: true, endCursor },
            nodes: nodes.map((node) => ({ [item]: node })),
          },
        },
      },
      rateLimit: rateLimit(),
    },
  };
}

const COMMITS_PER_DAY = 4;

// A repository total no single listed day reaches, standing for a day list
// that came back short.
export const TRUNCATED_COMMIT_TOTAL = 400;

export function commitDay(
  commitCount = COMMITS_PER_DAY,
  occurredAt = "2026-08-02T00:00:00Z",
): CommitDay {
  return { commitCount, occurredAt };
}

// Each repository lists one day of commits and reports `commitTotal` commits
// for the window, so a total above one day's count stands for days the list
// dropped.
export function commitContributions(
  count: number,
  commitTotal = COMMITS_PER_DAY,
): ContributionsCollection["commitContributionsByRepository"] {
  return Array.from({ length: count }, (_, index) => ({
    repository: repository(`repo-${index}`),
    contributions: { totalCount: commitTotal, nodes: [commitDay()] },
  }));
}

export function contributionsCollection(
  repositoryCount: number,
  commitTotal = COMMITS_PER_DAY,
  overrides: Partial<ContributionsCollection> = {},
): ContributionsCollection {
  return {
    totalCommitContributions: repositoryCount * commitTotal,
    totalPullRequestContributions: 40,
    totalPullRequestReviewContributions: 12,
    totalIssueContributions: 8,
    totalRepositoriesWithContributedCommits: repositoryCount,
    restrictedContributionsCount: 0,
    contributionYears: [2026, 2025],
    commitContributionsByRepository: commitContributions(repositoryCount, commitTotal),
    ...overrides,
  };
}

export function contributionsPayload(
  repositoryCount: number,
  commitTotal = COMMITS_PER_DAY,
  overrides: Partial<ContributionsCollection> = {},
): ContributionsPayload {
  return {
    data: {
      user: {
        contributionsCollection: contributionsCollection(repositoryCount, commitTotal, overrides),
      },
      rateLimit: rateLimit(),
    },
  };
}

export function commitDaysPayload(days: readonly string[]): ContributionsPayload {
  const commits = 2 * days.length;
  return contributionsPayload(1, commits, {
    totalCommitContributions: commits,
    commitContributionsByRepository: [
      {
        repository: repository("repo-0"),
        contributions: {
          totalCount: commits,
          nodes: days.map((day) => commitDay(2, `${day}T00:00:00Z`)),
        },
      },
    ],
  });
}

export function contributionsResponse(
  repositoryCount: number,
  commitTotal = COMMITS_PER_DAY,
): Response {
  return jsonResponse(contributionsPayload(repositoryCount, commitTotal));
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function requestBody(
  request: Request,
): Promise<{ query: string; variables: Record<string, unknown> }> {
  return request.json();
}
