import type {
  ContributionsCollection,
  IssueNode,
  PullRequestNode,
  Repository,
  ReviewedPullRequestNode,
} from "../src/github/schema";

export interface RateLimitOverrides {
  cost?: number;
  remaining?: number;
  resetAt?: string;
}

export function rateLimit(overrides: RateLimitOverrides = {}) {
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
export function searchPayload(nodes: readonly unknown[], overrides: SearchOverrides = {}) {
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

export function searchResponse(nodes: readonly unknown[], overrides: SearchOverrides = {}) {
  return jsonResponse(searchPayload(nodes, overrides));
}

export function commitDay(commitCount = 4, occurredAt = "2026-08-02T00:00:00Z") {
  return { commitCount, occurredAt };
}

export function commitContributions(
  count: number,
  dayTotal = 1,
): ContributionsCollection["commitContributionsByRepository"] {
  return Array.from({ length: count }, (_, index) => ({
    repository: repository(`repo-${index}`),
    contributions: { totalCount: dayTotal, nodes: [commitDay()] },
  }));
}

export function contributionsCollection(
  repositoryCount: number,
  dayTotal = 1,
  overrides: Partial<ContributionsCollection> = {},
): ContributionsCollection {
  return {
    totalCommitContributions: 120,
    totalPullRequestContributions: 40,
    totalPullRequestReviewContributions: 12,
    totalIssueContributions: 8,
    totalRepositoriesWithContributedCommits: repositoryCount,
    restrictedContributionsCount: 0,
    contributionYears: [2026, 2025],
    commitContributionsByRepository: commitContributions(repositoryCount, dayTotal),
    ...overrides,
  };
}

export function contributionsPayload(
  repositoryCount: number,
  dayTotal = 1,
  overrides: Partial<ContributionsCollection> = {},
) {
  return {
    data: {
      user: {
        contributionsCollection: contributionsCollection(repositoryCount, dayTotal, overrides),
      },
      rateLimit: rateLimit(),
    },
  };
}

export function contributionsResponse(repositoryCount: number, dayTotal = 1) {
  return jsonResponse(contributionsPayload(repositoryCount, dayTotal));
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
