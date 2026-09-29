import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { review, seedRepository } from "../../test/fixtures";
import { markPublished, publishedAt, readRow } from "../../test/tables";
import { upsertReviews } from "./reviews";

interface StoredReview {
  id: string;
  repository_id: string;
  pull_request_number: number;
  pull_request_author: string;
  state: string;
  submitted_at: string;
  published_at: string | null;
}

function read(id: string): Promise<StoredReview | null> {
  return readRow<StoredReview>(env.DB, "SELECT * FROM reviews WHERE id = ?", id);
}

describe("upsertReviews", () => {
  beforeEach(async () => {
    await seedRepository(env.DB);
  });

  it("writes a row that reads back as GitHub described it", async () => {
    const changed = await upsertReviews(env.DB, [review()]);

    expect(changed).toBe(1);
    expect(await read("PRR_review1")).toEqual({
      id: "PRR_review1",
      repository_id: "R_repo1",
      pull_request_number: 2,
      pull_request_author: "octocat",
      state: "APPROVED",
      submitted_at: "2026-09-09T16:20:00Z",
      published_at: null,
    });
  });

  it("writes every row in one call", async () => {
    const changed = await upsertReviews(env.DB, [
      review(),
      review({ id: "PRR_review2", pullRequestNumber: 3, state: "CHANGES_REQUESTED" }),
    ]);

    expect(changed).toBe(2);
    expect((await read("PRR_review2"))?.state).toBe("CHANGES_REQUESTED");
  });

  it("leaves a published row alone when nothing moved", async () => {
    await upsertReviews(env.DB, [review()]);
    await markPublished(env.DB, "reviews", "PRR_review1");

    const changed = await upsertReviews(env.DB, [review()]);

    expect(changed).toBe(0);
    expect((await read("PRR_review1"))?.published_at).toBe(publishedAt);
  });

  it("clears the publish marker when a column moved", async () => {
    await upsertReviews(env.DB, [review()]);
    await markPublished(env.DB, "reviews", "PRR_review1");

    const changed = await upsertReviews(env.DB, [review({ state: "DISMISSED" })]);

    expect(changed).toBe(1);
    const stored = await read("PRR_review1");
    expect(stored?.state).toBe("DISMISSED");
    expect(stored?.published_at).toBeNull();
  });

  it("rejects a review whose repository is not stored", async () => {
    await expect(upsertReviews(env.DB, [review({ repositoryId: "R_missing" })])).rejects.toThrow(
      "FOREIGN KEY constraint failed",
    );
  });
});
