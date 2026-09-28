import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { issue as storedIssue, review, seedRepository } from "../../test/fixtures";
import {
  type ContributionEventsField,
  contributionEventsPayload,
  contributionsCollection,
  issue,
  reviewedPullRequest,
} from "../../test/github-fixtures";
import { contributionEventsKey } from "../github/raw";
import type { EventKind } from "../github/windows";
import { upsertIssues } from "../store/issues";
import { upsertReviews } from "../store/reviews";
import { archivedYear, crossCheck } from "./cross-check";

// Nothing but reviews, so every other total agrees at zero.
function reported(reviews: number) {
  return contributionsCollection(0, undefined, {
    totalPullRequestContributions: 0,
    totalIssueContributions: 0,
    totalPullRequestReviewContributions: reviews,
  });
}

describe("crossCheck", () => {
  beforeEach(async () => {
    await seedRepository(env.DB);
    // Two pull requests first reviewed in 2026, one of them twice, and one
    // first reviewed in 2025 that drew another review in 2026.
    await upsertReviews(env.DB, [
      review({ id: "PRR_a", pullRequestNumber: 2, submittedAt: "2026-03-01T00:00:00Z" }),
      review({ id: "PRR_b", pullRequestNumber: 2, submittedAt: "2026-03-02T00:00:00Z" }),
      review({ id: "PRR_c", pullRequestNumber: 3, submittedAt: "2026-04-01T00:00:00Z" }),
      review({ id: "PRR_d", pullRequestNumber: 4, submittedAt: "2025-12-30T00:00:00Z" }),
      review({ id: "PRR_e", pullRequestNumber: 4, submittedAt: "2026-01-02T00:00:00Z" }),
    ]);
  });

  it("counts reviews as distinct pull requests by the year of their first review", async () => {
    await expect(crossCheck(env.DB, 2026, reported(2))).resolves.toBeNull();
    await expect(crossCheck(env.DB, 2025, reported(1))).resolves.toBeNull();
  });

  it("takes the login's own pull requests off GitHub's figure", async () => {
    await expect(
      crossCheck(env.DB, 2026, reported(5), { reviews: { pullRequests: 5, own: 3 } }),
    ).resolves.toBeNull();
  });

  it("reports GitHub's figure beside the own count and the stored pull requests", async () => {
    await expect(
      crossCheck(env.DB, 2026, reported(6), { reviews: { pullRequests: 6, own: 3 } }),
    ).resolves.toBe("2026 totals disagree: reviews 6 (3 own) vs 2 PRs (restricted 0)");
  });

  it("leaves the own count out when none was read", async () => {
    await expect(crossCheck(env.DB, 2026, reported(3))).resolves.toBe(
      "2026 totals disagree: reviews 3 vs 2 PRs (restricted 0)",
    );
  });
});

const FETCHED_AT = "2026-09-09T12:00:00.000Z";

function archivePage(
  kind: EventKind,
  window: string,
  field: ContributionEventsField,
  nodes: readonly unknown[],
): Promise<unknown> {
  return env.RAW.put(
    contributionEventsKey(kind, window, FETCHED_AT, 1),
    JSON.stringify(contributionEventsPayload(field, nodes)),
  );
}

describe("crossCheck against archived connection pages", () => {
  beforeEach(async () => {
    const listed = await env.RAW.list();
    await env.RAW.delete(listed.objects.map((object) => object.key));
    await seedRepository(env.DB);
    await upsertIssues(env.DB, [
      storedIssue({ id: "I_1", createdAt: "2026-02-01T00:00:00Z" }),
      storedIssue({ id: "I_9", createdAt: "2026-03-01T00:00:00Z" }),
    ]);
  });

  // Nothing but issues, so every other total agrees at zero.
  function issuesReported(issues: number) {
    return contributionsCollection(0, undefined, {
      totalPullRequestContributions: 0,
      totalPullRequestReviewContributions: 0,
      totalIssueContributions: issues,
    });
  }

  it("names the issues GitHub counts and the table lacks, and the reverse", async () => {
    await archivePage("issue", "2026", "issueContributions", [
      issue(1),
      issue(2, { id: "I_2" }),
      issue(3, { id: "I_3" }),
    ]);

    const archived = await archivedYear(env.RAW, 2026, "bendrucker");

    await expect(crossCheck(env.DB, 2026, issuesReported(3), archived)).resolves.toBe(
      "2026 totals disagree: issues 3 vs 2 (missing I_2, I_3; uncounted I_9) (restricted 0)",
    );
  });

  it("combines a year from the narrower windows the crawl split it into", async () => {
    await env.RAW.put(
      contributionEventsKey("issue", "2026", FETCHED_AT, 1),
      JSON.stringify(
        contributionEventsPayload("issueContributions", [issue(1)], { totalCount: 2 }),
      ),
    );
    await archivePage("issue", "2026-Q1", "issueContributions", [issue(1)]);
    await archivePage("issue", "2026-Q2", "issueContributions", [issue(9, { id: "I_9" })]);
    await archivePage("issue", "2026-Q3", "issueContributions", []);

    const archived = await archivedYear(env.RAW, 2026, "bendrucker");

    expect(archived.issues).toEqual(new Set(["I_1", "I_9"]));
  });

  it("leaves out a year whose split left a window unarchived", async () => {
    await archivePage("issue", "2026-Q1", "issueContributions", [issue(1)]);

    await expect(archivedYear(env.RAW, 2026, "bendrucker")).resolves.toEqual({});
  });

  it("falls back to the totals when the archive lists another number than GitHub reports", async () => {
    await archivePage("issue", "2026", "issueContributions", [issue(1)]);

    const archived = await archivedYear(env.RAW, 2026, "bendrucker");

    await expect(crossCheck(env.DB, 2026, issuesReported(3), archived)).resolves.toBe(
      "2026 totals disagree: issues 3 vs 2 (restricted 0)",
    );
  });

  it("counts the login's own pull requests off the archived review pages", async () => {
    await upsertReviews(env.DB, [
      review({ id: "PRR_a", pullRequestNumber: 2, submittedAt: "2026-03-01T00:00:00Z" }),
    ]);
    await archivePage("pr-reviewed", "2026", "pullRequestReviewContributions", [
      reviewedPullRequest(2),
      reviewedPullRequest(3, { author: { login: "bendrucker" } }),
      reviewedPullRequest(4, { author: { login: "bendrucker" } }),
    ]);
    const collection = contributionsCollection(0, undefined, {
      totalPullRequestContributions: 0,
      totalIssueContributions: 2,
      totalPullRequestReviewContributions: 3,
    });

    const archived = await archivedYear(env.RAW, 2026, "bendrucker");

    expect(archived.reviews).toEqual({ pullRequests: 3, own: 2 });
    await expect(crossCheck(env.DB, 2026, collection, archived)).resolves.toBeNull();
  });

  it("reports nothing archived as nothing to compare", async () => {
    await expect(archivedYear(env.RAW, 2026, "bendrucker")).resolves.toEqual({});
  });
});
