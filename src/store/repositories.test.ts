import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { repository } from "../../test/fixtures";
import { readRow } from "../../test/tables";
import { upsertRepositories } from "./repositories";

interface StoredRepository {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  url: string;
  stargazer_count: number;
  primary_language: string | null;
  primary_language_color: string | null;
  created_at: string;
  is_fork: number;
  visibility: string;
  fetched_at: string;
}

function read(id: string): Promise<StoredRepository | null> {
  return readRow<StoredRepository>(env.DB, "SELECT * FROM repositories WHERE id = ?", id);
}

describe("upsertRepositories", () => {
  it("writes a row that reads back as GitHub described it", async () => {
    const changed = await upsertRepositories(env.DB, [repository()]);

    expect(changed).toBe(1);
    expect(await read("R_repo1")).toEqual({
      id: "R_repo1",
      owner: "bendrucker",
      name: "logbook",
      description: "System of record for GitHub contribution data",
      url: "https://github.com/bendrucker/logbook",
      stargazer_count: 3,
      primary_language: "TypeScript",
      primary_language_color: "#3178c6",
      created_at: "2026-09-01T00:00:00Z",
      is_fork: 0,
      visibility: "PUBLIC",
      fetched_at: "2026-09-09T00:00:00Z",
    });
  });

  it("writes every row in one call", async () => {
    const changed = await upsertRepositories(env.DB, [
      repository(),
      repository({ id: "R_repo2", name: "activity-hub" }),
    ]);

    expect(changed).toBe(2);
    expect((await read("R_repo2"))?.name).toBe("activity-hub");
  });

  it("writes nothing for a row that has not moved", async () => {
    await upsertRepositories(env.DB, [repository()]);

    // A later fetch of an unchanged repository carries a new fetched_at, which
    // is exactly the column the comparison leaves out.
    const changed = await upsertRepositories(env.DB, [
      repository({ fetchedAt: "2026-09-10T00:00:00Z" }),
    ]);

    expect(changed).toBe(0);
    expect((await read("R_repo1"))?.fetched_at).toBe("2026-09-09T00:00:00Z");
  });

  it("carries fetched_at forward when something else moved", async () => {
    await upsertRepositories(env.DB, [repository()]);

    const changed = await upsertRepositories(env.DB, [
      repository({ stargazerCount: 4, fetchedAt: "2026-09-10T00:00:00Z" }),
    ]);

    expect(changed).toBe(1);
    const stored = await read("R_repo1");
    expect(stored?.stargazer_count).toBe(4);
    expect(stored?.fetched_at).toBe("2026-09-10T00:00:00Z");
  });

  it("treats a column going null as a change", async () => {
    await upsertRepositories(env.DB, [repository()]);

    const changed = await upsertRepositories(env.DB, [repository({ description: null })]);

    expect(changed).toBe(1);
    expect((await read("R_repo1"))?.description).toBeNull();
  });

  it("accepts an empty page without a round trip", async () => {
    expect(await upsertRepositories(env.DB, [])).toBe(0);
  });
});
