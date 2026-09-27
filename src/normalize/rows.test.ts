import { describe, expect, it } from "vitest";
import {
  commitDay,
  contributionsCollection,
  issue,
  pullRequest,
  repository,
  review,
  reviewedPullRequest,
} from "../../test/github-fixtures";
import type { Repository as RepositoryNode } from "../github/schema";
import type { Repository } from "../store";
import { contributionRows, issueRows, pullRequestRows, repositoryRow, reviewRows } from "./rows";

const FETCHED_AT = "2026-09-09T12:00:00.000Z";

describe("repositoryRow", () => {
  it("reads back as GitHub described it", () => {
    expect(repositoryRow(repository(), FETCHED_AT)).toEqual({
      id: "R_logbook",
      owner: "bendrucker",
      name: "logbook",
      description: "System of record for GitHub contribution data",
      url: "https://github.com/bendrucker/logbook",
      stargazerCount: 3,
      primaryLanguage: "TypeScript",
      primaryLanguageColor: "#3178c6",
      createdAt: "2026-08-01T00:00:00Z",
      isFork: false,
      visibility: "PUBLIC",
      fetchedAt: FETCHED_AT,
    });
  });

  it.each<{ name: string; node: RepositoryNode; expected: Partial<Repository> }>([
    {
      name: "flattens a missing primary language into both of its columns",
      node: repository("logbook", { primaryLanguage: null }),
      expected: { primaryLanguage: null, primaryLanguageColor: null },
    },
    {
      name: "carries a language that has no color",
      node: repository("logbook", { primaryLanguage: { name: "Nix", color: null } }),
      expected: { primaryLanguage: "Nix", primaryLanguageColor: null },
    },
    {
      name: "keeps a null description",
      node: repository("logbook", { description: null }),
      expected: { description: null },
    },
  ])("$name", ({ node, expected }) => {
    expect(repositoryRow(node, FETCHED_AT)).toMatchObject(expected);
  });
});

describe("pullRequestRows", () => {
  it("maps every column off the node", () => {
    const { pullRequest: row, repository: parent } = pullRequestRows(pullRequest(7), FETCHED_AT);

    expect(row).toEqual({
      id: "PR_7",
      repositoryId: "R_logbook",
      number: 7,
      title: "pull request 7",
      author: "bendrucker",
      createdAt: "2026-08-02T00:00:00Z",
      mergedAt: "2026-08-03T00:00:00Z",
      closedAt: "2026-08-03T00:00:00Z",
      state: "MERGED",
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      commentCount: 1,
      reviewCount: 2,
      updatedAt: "2026-08-03T00:00:00Z",
    });
    expect(parent.id).toBe("R_logbook");
  });

  it("keeps an open pull request undated", () => {
    const node = pullRequest(7, { state: "OPEN", mergedAt: null, closedAt: null });
    const { pullRequest: row } = pullRequestRows(node, FETCHED_AT);

    expect(row.mergedAt).toBeNull();
    expect(row.closedAt).toBeNull();
    expect(row.state).toBe("OPEN");
  });

  it("writes an empty author for a deleted account", () => {
    const { pullRequest: row } = pullRequestRows(pullRequest(7, { author: null }), FETCHED_AT);

    expect(row.author).toBe("");
  });
});

describe("reviewRows", () => {
  it("maps every review on the node to a row", () => {
    const node = reviewedPullRequest(7, {
      reviews: {
        totalCount: 2,
        nodes: [
          review(1, { state: "COMMENTED", submittedAt: "2026-08-03T01:00:00Z" }),
          review(2, { state: "APPROVED", submittedAt: "2026-08-03T02:00:00Z" }),
        ],
      },
    });

    const { reviews } = reviewRows(node, FETCHED_AT);

    expect(reviews).toEqual([
      {
        id: "PRR_1",
        repositoryId: "R_logbook",
        pullRequestNumber: 7,
        pullRequestAuthor: "someone",
        state: "COMMENTED",
        submittedAt: "2026-08-03T01:00:00Z",
      },
      {
        id: "PRR_2",
        repositoryId: "R_logbook",
        pullRequestNumber: 7,
        pullRequestAuthor: "someone",
        state: "APPROVED",
        submittedAt: "2026-08-03T02:00:00Z",
      },
    ]);
  });

  it("drops a review that was never submitted", () => {
    const node = reviewedPullRequest(7, {
      reviews: {
        totalCount: 2,
        nodes: [review(1), review(2, { state: "PENDING", submittedAt: null })],
      },
    });

    expect(reviewRows(node, FETCHED_AT).reviews.map((row) => row.id)).toEqual(["PRR_1"]);
  });

  it("carries the pull request author so a review of my own work is separable", () => {
    const node = reviewedPullRequest(7, { author: { login: "bendrucker" } });

    expect(reviewRows(node, FETCHED_AT).reviews[0]?.pullRequestAuthor).toBe("bendrucker");
  });

  it("writes an empty pull request author for a deleted account", () => {
    const node = reviewedPullRequest(7, { author: null });

    expect(reviewRows(node, FETCHED_AT).reviews[0]?.pullRequestAuthor).toBe("");
  });
});

describe("issueRows", () => {
  it("maps every column off the node", () => {
    const { issue: row } = issueRows(issue(9), FETCHED_AT);

    expect(row).toEqual({
      id: "I_9",
      repositoryId: "R_logbook",
      number: 9,
      title: "issue 9",
      author: "bendrucker",
      createdAt: "2026-08-02T00:00:00Z",
      closedAt: null,
      state: "OPEN",
      commentCount: 0,
      updatedAt: "2026-08-02T00:00:00Z",
    });
  });

  it("keeps the close date GitHub returned", () => {
    const node = issue(9, { state: "CLOSED", closedAt: "2026-08-04T00:00:00Z" });

    expect(issueRows(node, FETCHED_AT).issue.closedAt).toBe("2026-08-04T00:00:00Z");
  });
});

describe("contributionRows", () => {
  // One repository with two days, so the date part of each timestamp is what
  // separates the rows.
  const collection = contributionsCollection(1, 5, {
    commitContributionsByRepository: [
      {
        repository: repository("logbook"),
        contributions: {
          totalCount: 5,
          nodes: [commitDay(4, "2026-08-02T00:00:00Z"), commitDay(1, "2026-08-03T12:30:00Z")],
        },
      },
    ],
  });

  it("keys a commit count by the date part of its timestamp", () => {
    expect(contributionRows(collection, FETCHED_AT).commitDays).toEqual([
      { repositoryId: "R_logbook", day: "2026-08-02", commitCount: 4 },
      { repositoryId: "R_logbook", day: "2026-08-03", commitCount: 1 },
    ]);
  });

  it("returns the repository each contribution names", () => {
    const { repositories } = contributionRows(collection, FETCHED_AT);

    expect(repositories.map((row) => row.id)).toEqual(["R_logbook"]);
    expect(repositories[0]?.fetchedAt).toBe(FETCHED_AT);
  });
});
