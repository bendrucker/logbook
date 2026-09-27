import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitDaysPayload,
  contributionsPayload,
  TRUNCATED_COMMIT_TOTAL,
  issue,
  pullRequest,
  repository,
  review,
  reviewedPullRequest,
  type SearchOverrides,
  searchPayload,
} from "../../test/github-fixtures";
import { readRow } from "../../test/tables";
import { contributionsKey, searchKey } from "../github/raw";
import { SEARCH_MAX_RESULTS } from "../github/search";
import type { EventKind } from "../github/windows";
import {
  MissingRawObjectError,
  RawValidationError,
  replayContributions,
  replaySearchWindow,
} from "./replay";

const WINDOW = "2026-08";
const EARLIER = "2026-09-09T11:00:00.000Z";
const LATER = "2026-09-09T12:00:00.000Z";

async function clearRaw(): Promise<void> {
  const listed = await env.RAW.list();
  await env.RAW.delete(listed.objects.map((object) => object.key));
}

beforeEach(clearRaw);

function archive(
  kind: EventKind,
  fetchedAt: string,
  page: number,
  nodes: readonly unknown[],
  overrides: SearchOverrides = {},
): Promise<unknown> {
  return env.RAW.put(
    searchKey(kind, WINDOW, fetchedAt, page),
    JSON.stringify(searchPayload(nodes, overrides)),
  );
}

function count(table: string): Promise<{ total: number } | null> {
  return readRow<{ total: number }>(env.DB, `SELECT COUNT(*) AS total FROM ${table}`);
}

describe("replaySearchWindow", () => {
  it("normalizes an archived window without calling GitHub", async () => {
    await archive("pr-authored", LATER, 1, [pullRequest(1), pullRequest(2)]);

    const replayed = await replaySearchWindow(env.DB, env.RAW, "pr-authored", WINDOW);

    expect(replayed?.fetchedAt).toBe(LATER);
    expect(replayed?.rows.pullRequests).toBe(2);
    expect(await count("pull_requests")).toEqual({ total: 2 });
  });

  it("stamps the repository with the fetch that produced the page", async () => {
    await archive("pr-authored", LATER, 1, [pullRequest(1)]);

    await replaySearchWindow(env.DB, env.RAW, "pr-authored", WINDOW);

    const stored = await readRow<{ fetched_at: string }>(
      env.DB,
      "SELECT fetched_at FROM repositories WHERE id = ?",
      "R_logbook",
    );
    expect(stored?.fetched_at).toBe(LATER);
  });

  it("reads the newest fetch and leaves the one before it alone", async () => {
    await archive("issue", EARLIER, 1, [issue(1)]);
    await archive("issue", LATER, 1, [issue(2)]);

    const replayed = await replaySearchWindow(env.DB, env.RAW, "issue", WINDOW);

    expect(replayed?.fetchedAt).toBe(LATER);
    expect(await count("issues")).toEqual({ total: 1 });
    const stored = await readRow<{ id: string }>(env.DB, "SELECT id FROM issues");
    expect(stored?.id).toBe("I_2");
  });

  it("applies a fetch's pages in key order", async () => {
    await Promise.all([
      archive("issue", LATER, 1, [issue(1, { title: "the first page" })]),
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((page) => archive("issue", LATER, page, [issue(page)])),
      archive("issue", LATER, 10, [issue(1, { title: "the tenth page" })]),
    ]);

    await replaySearchWindow(env.DB, env.RAW, "issue", WINDOW);

    expect(await count("issues")).toEqual({ total: 9 });
    const stored = await readRow<{ title: string }>(
      env.DB,
      "SELECT title FROM issues WHERE id = ?",
      "I_1",
    );
    // The last write wins only because a padded 10 sorts after 1 rather than
    // between 1 and 2.
    expect(stored?.title).toBe("the tenth page");
  });

  it("writes one repository for a window that names it on every page", async () => {
    await archive("pr-authored", LATER, 1, [pullRequest(1)]);
    await archive("pr-authored", LATER, 2, [pullRequest(2)]);

    const replayed = await replaySearchWindow(env.DB, env.RAW, "pr-authored", WINDOW);

    expect(replayed?.rows.repositories).toBe(1);
  });

  it("keys a replayed repository off the node id", async () => {
    await archive("pr-authored", LATER, 1, [
      pullRequest(1, { repository: repository("activity-hub") }),
    ]);

    await replaySearchWindow(env.DB, env.RAW, "pr-authored", WINDOW);

    const stored = await readRow<{ name: string }>(
      env.DB,
      "SELECT name FROM repositories WHERE id = ?",
      "R_activity-hub",
    );
    expect(stored?.name).toBe("activity-hub");
  });

  it("replays a reviewed window onto the reviews table", async () => {
    await archive("pr-reviewed", LATER, 1, [reviewedPullRequest(7)]);

    const replayed = await replaySearchWindow(env.DB, env.RAW, "pr-reviewed", WINDOW);

    expect(replayed?.rows.reviews).toBe(1);
  });

  it("changes nothing on a second replay of the same window", async () => {
    await archive("pr-authored", LATER, 1, [pullRequest(1)]);
    await replaySearchWindow(env.DB, env.RAW, "pr-authored", WINDOW);

    const replayed = await replaySearchWindow(env.DB, env.RAW, "pr-authored", WINDOW);

    expect(replayed?.rows).toEqual({
      repositories: 0,
      pullRequests: 0,
      reviews: 0,
      issues: 0,
      commitDays: 0,
    });
  });

  it("walks back to the last fetch that finished paginating", async () => {
    await archive("issue", EARLIER, 1, [issue(1)]);
    // Interrupted after its first page: the cursor it announced was never
    // followed, so the newer fetch holds a fraction of the window.
    await archive("issue", LATER, 1, [issue(2)], { endCursor: "Y3Vyc29yCg" });

    const replayed = await replaySearchWindow(env.DB, env.RAW, "issue", WINDOW);

    expect(replayed?.fetchedAt).toBe(EARLIER);
    const stored = await readRow<{ id: string }>(env.DB, "SELECT id FROM issues");
    expect(stored?.id).toBe("I_1");
  });

  it("skips a fetch that lost a page between its first and its last", async () => {
    await archive("issue", EARLIER, 1, [issue(1)]);
    await archive("issue", LATER, 1, [issue(2)]);
    await archive("issue", LATER, 3, [issue(3)]);

    const replayed = await replaySearchWindow(env.DB, env.RAW, "issue", WINDOW);

    expect(replayed?.fetchedAt).toBe(EARLIER);
  });

  it("replays the newest fetch when none of them finished", async () => {
    await archive("issue", EARLIER, 1, [issue(1)], { endCursor: "ZWFybGllcgo" });
    await archive("issue", LATER, 1, [issue(2)], { endCursor: "bGF0ZXIK" });

    const replayed = await replaySearchWindow(env.DB, env.RAW, "issue", WINDOW);

    expect(replayed?.fetchedAt).toBe(LATER);
  });

  it("reports a window whose match count passed the search cap", async () => {
    await archive("pr-authored", LATER, 1, [pullRequest(1)], {
      issueCount: SEARCH_MAX_RESULTS + 1,
    });

    const replayed = await replaySearchWindow(env.DB, env.RAW, "pr-authored", WINDOW);

    expect(replayed?.truncated).toBe(true);
  });

  it("reports a pull request whose reviews outran their one page", async () => {
    const node = reviewedPullRequest(7, {
      reviews: { totalCount: 2, nodes: [review(7)] },
    });
    await archive("pr-reviewed", LATER, 1, [node]);

    const replayed = await replaySearchWindow(env.DB, env.RAW, "pr-reviewed", WINDOW);

    expect(replayed?.truncated).toBe(true);
  });

  it("reports a window GitHub returned whole", async () => {
    await archive("pr-reviewed", LATER, 1, [reviewedPullRequest(7)]);

    const replayed = await replaySearchWindow(env.DB, env.RAW, "pr-reviewed", WINDOW);

    expect(replayed?.truncated).toBe(false);
  });

  it("reports a window nothing was archived under", async () => {
    await expect(replaySearchWindow(env.DB, env.RAW, "issue", "2011-01")).resolves.toBeNull();
  });

  it.each<{ name: string; kind: EventKind; body: string }>([
    {
      name: "a body no longer validates",
      kind: "pr-authored",
      body: JSON.stringify(searchPayload([{ ...pullRequest(1), additions: "10" }])),
    },
    { name: "a body is not JSON", kind: "issue", body: "<html>502</html>" },
  ])("names the key when $name", async ({ kind, body }) => {
    const key = searchKey(kind, WINDOW, LATER, 1);
    await env.RAW.put(key, body);

    const replay = replaySearchWindow(env.DB, env.RAW, kind, WINDOW);

    await expect(replay).rejects.toThrow(RawValidationError);
    await expect(replay).rejects.toMatchObject({ key });
  });

  it("reports a window whose objects were deleted", async () => {
    const key = searchKey("issue", WINDOW, LATER, 1);
    await env.RAW.put(key, JSON.stringify(searchPayload([issue(1)])));
    await env.RAW.delete(key);

    // The fetch prefix survives its objects in neither R2 nor the listing, so a
    // window emptied between the two calls reads as nothing archived.
    await expect(replaySearchWindow(env.DB, env.RAW, "issue", WINDOW)).resolves.toBeNull();
  });
});

describe("replayContributions", () => {
  it("normalizes the newest archived year", async () => {
    await env.RAW.put(contributionsKey("2026", EARLIER), JSON.stringify(contributionsPayload(1)));
    await env.RAW.put(contributionsKey("2026", LATER), JSON.stringify(contributionsPayload(3)));

    const replayed = await replayContributions(env.DB, env.RAW, 2026);

    expect(replayed?.fetchedAt).toBe(LATER);
    expect(replayed?.rows.commitDays).toBe(3);
    expect(replayed?.truncated).toBe(false);
    expect(await count("repositories")).toEqual({ total: 3 });
  });

  it("reports a repository that committed on more days than one page holds", async () => {
    const body = JSON.stringify(contributionsPayload(1, TRUNCATED_COMMIT_TOTAL));
    await env.RAW.put(contributionsKey("2026", LATER), body);

    const replayed = await replayContributions(env.DB, env.RAW, 2026);

    expect(replayed?.truncated).toBe(true);
  });

  it("adds the quarters archived with the same fetch as a truncated year", async () => {
    const year = JSON.stringify(contributionsPayload(1, TRUNCATED_COMMIT_TOTAL));
    await env.RAW.put(contributionsKey("2026", LATER), year);
    const days: [string, string][] = [
      ["2026-Q1", "2026-02-10"],
      ["2026-Q2", "2026-05-10"],
      ["2026-Q3", "2026-08-10"],
    ];
    await Promise.all(
      days.map(([quarter, day]) =>
        env.RAW.put(contributionsKey(quarter, LATER), JSON.stringify(commitDaysPayload([day]))),
      ),
    );

    const replayed = await replayContributions(env.DB, env.RAW, 2026);

    expect(replayed?.truncated).toBe(false);
    expect(replayed?.rows.commitDays).toBe(4);
  });

  it("keeps a year truncated when a quarter from its fetch is missing", async () => {
    const year = JSON.stringify(contributionsPayload(1, TRUNCATED_COMMIT_TOTAL));
    await env.RAW.put(contributionsKey("2026", LATER), year);
    await env.RAW.put(
      contributionsKey("2026-Q1", LATER),
      JSON.stringify(commitDaysPayload(["2026-02-10"])),
    );
    await env.RAW.put(
      contributionsKey("2026-Q2", EARLIER),
      JSON.stringify(commitDaysPayload(["2026-05-10"])),
    );

    const replayed = await replayContributions(env.DB, env.RAW, 2026);

    expect(replayed?.truncated).toBe(true);
    expect(replayed?.rows.commitDays).toBe(2);
  });

  it("reports a year nothing was archived under", async () => {
    await expect(replayContributions(env.DB, env.RAW, 2011)).resolves.toBeNull();
  });

  it("names the key when the response carries no user", async () => {
    const key = contributionsKey("2026", LATER);
    await env.RAW.put(key, JSON.stringify({ data: { user: null } }));

    await expect(replayContributions(env.DB, env.RAW, 2026)).rejects.toMatchObject({
      key,
      name: "RawValidationError",
    });
  });

  it("changes nothing on a second replay of the same year", async () => {
    await env.RAW.put(contributionsKey("2026", LATER), JSON.stringify(contributionsPayload(2)));
    await replayContributions(env.DB, env.RAW, 2026);

    const replayed = await replayContributions(env.DB, env.RAW, 2026);

    expect(replayed?.rows.commitDays).toBe(0);
    expect(replayed?.rows.repositories).toBe(0);
  });
});

describe("MissingRawObjectError", () => {
  it("carries the key it could not read", () => {
    const error = new MissingRawObjectError("raw/search/issue/2026-08/fetch/0001.json");

    expect(error.name).toBe("MissingRawObjectError");
    expect(error.key).toBe("raw/search/issue/2026-08/fetch/0001.json");
  });
});
