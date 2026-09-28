import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { review, seedRepository } from "../../test/fixtures";
import { contributionsCollection } from "../../test/github-fixtures";
import { upsertReviews } from "../store/reviews";
import { crossCheck } from "./cross-check";

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
    await expect(crossCheck(env.DB, 2026, reported(5), 3)).resolves.toBeNull();
  });

  it("reports GitHub's figure beside the own count and the stored pull requests", async () => {
    await expect(crossCheck(env.DB, 2026, reported(6), 3)).resolves.toBe(
      "2026 totals disagree: reviews 6 (3 own) vs 2 PRs (restricted 0)",
    );
  });

  it("leaves the own count out when none was read", async () => {
    await expect(crossCheck(env.DB, 2026, reported(3))).resolves.toBe(
      "2026 totals disagree: reviews 3 vs 2 PRs (restricted 0)",
    );
  });
});
