import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  contributionsCollection,
  issue,
  pullRequest,
  repository,
  review,
  reviewedPullRequest,
} from "../../test/github-fixtures";
import { readRow } from "../../test/tables";
import { normalizeContributions, normalizeSearchPage } from "./page";

const FETCHED_AT = "2026-09-09T12:00:00.000Z";

function count(table: string): Promise<{ total: number } | null> {
  return readRow<{ total: number }>(env.DB, `SELECT COUNT(*) AS total FROM ${table}`);
}

describe("normalizeSearchPage", () => {
  it("writes the repository before the pull request that references it", async () => {
    const rows = await normalizeSearchPage(
      env.DB,
      { kind: "pr-authored", nodes: [pullRequest(7)] },
      FETCHED_AT,
    );

    expect(rows).toEqual({
      repositories: 1,
      pullRequests: 1,
      reviews: 0,
      issues: 0,
      commitDays: 0,
    });
    const stored = await readRow<{ repository_id: string; author: string }>(
      env.DB,
      "SELECT repository_id, author FROM pull_requests WHERE id = ?",
      "PR_7",
    );
    expect(stored).toEqual({ repository_id: "R_logbook", author: "bendrucker" });
  });

  it("writes one repository for every node in the page that names it", async () => {
    const rows = await normalizeSearchPage(
      env.DB,
      { kind: "pr-authored", nodes: [pullRequest(1), pullRequest(2), pullRequest(3)] },
      FETCHED_AT,
    );

    expect(rows.repositories).toBe(1);
    expect(rows.pullRequests).toBe(3);
    expect(await count("repositories")).toEqual({ total: 1 });
  });

  it("writes each distinct repository the page names", async () => {
    const nodes = [
      pullRequest(1),
      pullRequest(2, { repository: repository("activity-hub") }),
      pullRequest(3, { repository: repository("activity-hub") }),
    ];

    const rows = await normalizeSearchPage(env.DB, { kind: "pr-authored", nodes }, FETCHED_AT);

    expect(rows.repositories).toBe(2);
    expect(await count("repositories")).toEqual({ total: 2 });
  });

  it("changes nothing when the same page arrives twice", async () => {
    const nodes = [pullRequest(1), pullRequest(2)];
    await normalizeSearchPage(env.DB, { kind: "pr-authored", nodes }, FETCHED_AT);

    // The second pass carries a later fetch, which repositories write but do
    // not compare, so an unchanged page still reports no rows changed.
    const rows = await normalizeSearchPage(
      env.DB,
      { kind: "pr-authored", nodes },
      "2026-09-10T12:00:00.000Z",
    );

    expect(rows).toEqual({
      repositories: 0,
      pullRequests: 0,
      reviews: 0,
      issues: 0,
      commitDays: 0,
    });
  });

  it("writes every review a reviewed pull request carries", async () => {
    const nodes = [
      reviewedPullRequest(7, {
        reviews: {
          totalCount: 2,
          nodes: [
            review(1, { submittedAt: "2026-08-03T01:00:00Z" }),
            review(2, { state: "COMMENTED", submittedAt: "2026-08-03T02:00:00Z" }),
          ],
        },
      }),
    ];

    const rows = await normalizeSearchPage(env.DB, { kind: "pr-reviewed", nodes }, FETCHED_AT);

    expect(rows.reviews).toBe(2);
    expect(rows.repositories).toBe(1);
    const stored = await readRow<{ pull_request_author: string; pull_request_number: number }>(
      env.DB,
      "SELECT pull_request_author, pull_request_number FROM reviews WHERE id = ?",
      "PRR_2",
    );
    expect(stored).toEqual({ pull_request_author: "someone", pull_request_number: 7 });
  });

  it("changes nothing when the same reviewed page arrives twice", async () => {
    const nodes = [reviewedPullRequest(7)];
    await normalizeSearchPage(env.DB, { kind: "pr-reviewed", nodes }, FETCHED_AT);

    const rows = await normalizeSearchPage(env.DB, { kind: "pr-reviewed", nodes }, FETCHED_AT);

    expect(rows.reviews).toBe(0);
  });

  it("writes an issue page under its own table", async () => {
    const rows = await normalizeSearchPage(
      env.DB,
      { kind: "issue", nodes: [issue(9), issue(10)] },
      FETCHED_AT,
    );

    expect(rows.issues).toBe(2);
    expect(rows.pullRequests).toBe(0);
    expect(await count("issues")).toEqual({ total: 2 });
  });

  it("accepts an empty page", async () => {
    const rows = await normalizeSearchPage(env.DB, { kind: "issue", nodes: [] }, FETCHED_AT);

    expect(rows).toEqual({
      repositories: 0,
      pullRequests: 0,
      reviews: 0,
      issues: 0,
      commitDays: 0,
    });
  });

  it("carries a moved field onto the stored row", async () => {
    await normalizeSearchPage(env.DB, { kind: "issue", nodes: [issue(9)] }, FETCHED_AT);

    const nodes = [issue(9, { state: "CLOSED", closedAt: "2026-08-05T00:00:00Z" })];
    const rows = await normalizeSearchPage(env.DB, { kind: "issue", nodes }, FETCHED_AT);

    expect(rows.issues).toBe(1);
    const stored = await readRow<{ state: string }>(
      env.DB,
      "SELECT state FROM issues WHERE id = ?",
      "I_9",
    );
    expect(stored?.state).toBe("CLOSED");
  });
});

describe("normalizeContributions", () => {
  it("writes a commit day per repository", async () => {
    const rows = await normalizeContributions(env.DB, contributionsCollection(3), FETCHED_AT);

    expect(rows.repositories).toBe(3);
    expect(rows.commitDays).toBe(3);
    const stored = await readRow<{ day: string; commit_count: number }>(
      env.DB,
      "SELECT day, commit_count FROM commit_days WHERE repository_id = ?",
      "R_repo-0",
    );
    expect(stored).toEqual({ day: "2026-08-02", commit_count: 4 });
  });

  it("changes nothing when the same year arrives twice", async () => {
    await normalizeContributions(env.DB, contributionsCollection(2), FETCHED_AT);

    const rows = await normalizeContributions(env.DB, contributionsCollection(2), FETCHED_AT);

    expect(rows.repositories).toBe(0);
    expect(rows.commitDays).toBe(0);
  });
});
