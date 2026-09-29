import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { issue, seedRepository } from "../../test/fixtures";
import { markPublished, publishedAt, readRow } from "../../test/tables";
import { upsertIssues } from "./issues";

interface StoredIssue {
  id: string;
  repository_id: string;
  number: number;
  title: string;
  author: string;
  created_at: string;
  closed_at: string | null;
  state: string;
  comment_count: number;
  updated_at: string;
  published_at: string | null;
}

function read(id: string): Promise<StoredIssue | null> {
  return readRow<StoredIssue>(env.DB, "SELECT * FROM issues WHERE id = ?", id);
}

describe("upsertIssues", () => {
  beforeEach(async () => {
    await seedRepository(env.DB);
  });

  it("writes a row that reads back as GitHub described it", async () => {
    const changed = await upsertIssues(env.DB, [issue()]);

    expect(changed).toBe(1);
    expect(await read("I_issue1")).toEqual({
      id: "I_issue1",
      repository_id: "R_repo1",
      number: 7,
      title: "publish the code feed",
      author: "bendrucker",
      created_at: "2026-09-09T17:00:00Z",
      closed_at: null,
      state: "OPEN",
      comment_count: 2,
      updated_at: "2026-09-09T17:00:00Z",
      published_at: null,
    });
  });

  it("writes every row in one call", async () => {
    const changed = await upsertIssues(env.DB, [
      issue(),
      issue({ id: "I_issue2", number: 8, title: "backfill from the archive" }),
    ]);

    expect(changed).toBe(2);
    expect((await read("I_issue2"))?.title).toBe("backfill from the archive");
  });

  it("leaves a published row alone when nothing moved", async () => {
    await upsertIssues(env.DB, [issue()]);
    await markPublished(env.DB, "issues", "I_issue1");

    const changed = await upsertIssues(env.DB, [issue()]);

    expect(changed).toBe(0);
    expect((await read("I_issue1"))?.published_at).toBe(publishedAt);
  });

  it("clears the publish marker when a column moved", async () => {
    await upsertIssues(env.DB, [issue()]);
    await markPublished(env.DB, "issues", "I_issue1");

    const changed = await upsertIssues(env.DB, [
      issue({ state: "CLOSED", closedAt: "2026-09-09T18:30:00Z" }),
    ]);

    expect(changed).toBe(1);
    const stored = await read("I_issue1");
    expect(stored?.closed_at).toBe("2026-09-09T18:30:00Z");
    expect(stored?.published_at).toBeNull();
  });

  it("rejects an issue whose repository is not stored", async () => {
    await expect(upsertIssues(env.DB, [issue({ repositoryId: "R_missing" })])).rejects.toThrow(
      "FOREIGN KEY constraint failed",
    );
  });
});
