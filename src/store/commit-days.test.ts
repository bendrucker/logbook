import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commitDay, seedRepository } from "../../test/fixtures";
import { readRow } from "../../test/tables";
import { upsertCommitDays } from "./commit-days";

interface StoredCommitDay {
  repository_id: string;
  day: string;
  commit_count: number;
}

function read(day: string): Promise<StoredCommitDay | null> {
  return readRow<StoredCommitDay>(
    env.DB,
    "SELECT * FROM commit_days WHERE repository_id = ? AND day = ?",
    "R_repo1",
    day,
  );
}

describe("upsertCommitDays", () => {
  beforeEach(async () => {
    await seedRepository(env.DB);
  });

  it("writes a row that reads back as GitHub counted it", async () => {
    const changed = await upsertCommitDays(env.DB, [commitDay()]);

    expect(changed).toBe(1);
    expect(await read("2026-09-09")).toEqual({
      repository_id: "R_repo1",
      day: "2026-09-09",
      commit_count: 4,
    });
  });

  it("writes every row in one call", async () => {
    const changed = await upsertCommitDays(env.DB, [
      commitDay(),
      commitDay({ day: "2026-09-08", commitCount: 1 }),
    ]);

    expect(changed).toBe(2);
    expect((await read("2026-09-08"))?.commit_count).toBe(1);
  });

  it("writes nothing for a day whose count has not moved", async () => {
    await upsertCommitDays(env.DB, [commitDay()]);

    expect(await upsertCommitDays(env.DB, [commitDay()])).toBe(0);
  });

  it("revises a day the sync window covers again", async () => {
    await upsertCommitDays(env.DB, [commitDay()]);

    const changed = await upsertCommitDays(env.DB, [commitDay({ commitCount: 6 })]);

    expect(changed).toBe(1);
    expect((await read("2026-09-09"))?.commit_count).toBe(6);
  });

  it("keys a day per repository", async () => {
    await seedRepository(env.DB, { id: "R_repo2", name: "activity-hub" });

    await upsertCommitDays(env.DB, [
      commitDay(),
      commitDay({ repositoryId: "R_repo2", commitCount: 9 }),
    ]);

    expect((await read("2026-09-09"))?.commit_count).toBe(4);
  });

  it("rejects a day whose repository is not stored", async () => {
    await expect(
      upsertCommitDays(env.DB, [commitDay({ repositoryId: "R_missing" })]),
    ).rejects.toThrow("FOREIGN KEY constraint failed");
  });
});
