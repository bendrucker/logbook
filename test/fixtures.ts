import type { CommitDay } from "../src/store/commit-days";
import type { Issue } from "../src/store/issues";
import type { PullRequest } from "../src/store/pull-requests";
import { type Repository, upsertRepositories } from "../src/store/repositories";
import type { Review } from "../src/store/reviews";

export function repository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "R_repo1",
    owner: "bendrucker",
    name: "logbook",
    description: "System of record for GitHub contribution data",
    url: "https://github.com/bendrucker/logbook",
    stargazerCount: 3,
    primaryLanguage: "TypeScript",
    primaryLanguageColor: "#3178c6",
    createdAt: "2026-09-01T00:00:00Z",
    isFork: false,
    visibility: "PUBLIC",
    fetchedAt: "2026-09-09T00:00:00Z",
    ...overrides,
  };
}

export function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "PR_pull1",
    repositoryId: "R_repo1",
    number: 2,
    title: "add README and design doc",
    author: "bendrucker",
    createdAt: "2026-09-09T16:00:00Z",
    mergedAt: "2026-09-09T16:30:00Z",
    closedAt: "2026-09-09T16:30:00Z",
    state: "MERGED",
    additions: 345,
    deletions: 2,
    changedFiles: 2,
    commentCount: 0,
    reviewCount: 1,
    updatedAt: "2026-09-09T16:30:00Z",
    ...overrides,
  };
}

export function review(overrides: Partial<Review> = {}): Review {
  return {
    id: "PRR_review1",
    repositoryId: "R_repo1",
    pullRequestNumber: 2,
    pullRequestAuthor: "octocat",
    state: "APPROVED",
    submittedAt: "2026-09-09T16:20:00Z",
    ...overrides,
  };
}

export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "I_issue1",
    repositoryId: "R_repo1",
    number: 7,
    title: "publish the code feed",
    author: "bendrucker",
    createdAt: "2026-09-09T17:00:00Z",
    closedAt: null,
    state: "OPEN",
    commentCount: 2,
    updatedAt: "2026-09-09T17:00:00Z",
    ...overrides,
  };
}

export function commitDay(overrides: Partial<CommitDay> = {}): CommitDay {
  return {
    repositoryId: "R_repo1",
    day: "2026-09-09",
    commitCount: 4,
    ...overrides,
  };
}

// Every event table has a foreign key to repositories, so a test writing one
// needs its parent present first.
export function seedRepository(
  db: D1Database,
  overrides: Partial<Repository> = {},
): Promise<number> {
  return upsertRepositories(db, [repository(overrides)]);
}
