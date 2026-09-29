import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitDaysPayload,
  contributionEventsPayload,
  contributionsPayload,
  TRUNCATED_COMMIT_TOTAL,
  issue,
  pullRequest,
  repository,
  review,
  reviewedPullRequest,
  reviewsPayload,
  type SearchOverrides,
  searchPayload,
} from "../../test/github-fixtures";
import { readRow } from "../../test/tables";
import {
  contributionEventsKey,
  contributionsKey,
  searchKey,
  searchReviewsKey,
} from "../github/raw";
import { OPEN_CONNECTIONS } from "../concurrency";
import { SEARCH_MAX_RESULTS } from "../github/search";
import type { EventKind } from "../github/windows";
import {
  MissingRawObjectError,
  RawValidationError,
  replayContributionEvents,
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

// `repositories` above the number listed stands for repositories the window dropped.
function commitsPayload(
  entries: readonly (readonly [string, string, number])[],
  repositories?: number,
) {
  const names = [...new Set(entries.map(([name]) => name))];
  const listed = names.map((name) => {
    const nodes = entries
      .filter(([each]) => each === name)
      .map(([, day, commitCount]) => ({ commitCount, occurredAt: `${day}T07:00:00Z` }));
    const commits = nodes.reduce((total, node) => total + node.commitCount, 0);
    return { repository: repository(name), contributions: { totalCount: commits, nodes } };
  });
  const commits = entries.reduce((total, entry) => total + entry[2], 0);
  return contributionsPayload(0, 0, {
    totalCommitContributions: commits,
    totalRepositoriesWithContributedCommits: repositories ?? names.length,
    commitContributionsByRepository: listed,
  });
}

// The most reads `bucket` had open at once, counted from each get to the
// object it resolves with.
function watchReads(bucket: R2Bucket): { bucket: R2Bucket; most: () => number } {
  let open = 0;
  let most = 0;
  const watched = new Proxy(bucket, {
    get(target, property) {
      if (property === "get") {
        return async (key: string) => {
          open += 1;
          most = Math.max(most, open);
          try {
            return await target.get(key);
          } finally {
            open -= 1;
          }
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? (value.bind(target) as unknown) : value;
    },
  });
  return { bucket: watched, most: () => most };
}

function commitDays() {
  return env.DB.prepare(
    "SELECT repository_id, day, commit_count FROM commit_days ORDER BY repository_id, day",
  )
    .all()
    .then(({ results }) => results);
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

  it("reads a long fetch a few pages at a time", async () => {
    const pages = Array.from({ length: 20 }, (_, index) => index + 1);
    await Promise.all(pages.map((page) => archive("issue", LATER, page, [issue(page)])));
    const reads = watchReads(env.RAW);

    await replaySearchWindow(env.DB, reads.bucket, "issue", WINDOW);

    expect(await count("issues")).toEqual({ total: 20 });
    expect(reads.most()).toBeGreaterThan(1);
    expect(reads.most()).toBeLessThanOrEqual(OPEN_CONNECTIONS);
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

  it("completes a pull request's reviews from its archived follow-up", async () => {
    const node = reviewedPullRequest(7, {
      id: "MDExOlB1bGxSZXF1ZXN0/w==",
      reviews: {
        totalCount: 2,
        pageInfo: { hasNextPage: true, endCursor: "cmV2" },
        nodes: [review(7)],
      },
    });
    await archive("pr-reviewed", LATER, 1, [node]);
    await env.RAW.put(
      searchReviewsKey("pr-reviewed", WINDOW, LATER, node.id, 1),
      JSON.stringify(reviewsPayload([review(8)], { totalCount: 2 })),
    );

    const replayed = await replaySearchWindow(env.DB, env.RAW, "pr-reviewed", WINDOW);

    expect(replayed).toMatchObject({ fetchedAt: LATER, truncated: false });
    expect(replayed?.rows.reviews).toBe(2);
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

    const replayed = await replayContributions(env.DB, env.RAW, "2026");

    expect(replayed?.fetchedAt).toBe(LATER);
    expect(replayed?.rows.commitDays).toBe(3);
    expect(replayed?.truncated).toBe(false);
    expect(await count("repositories")).toEqual({ total: 3 });
  });

  it("reports a repository that committed on more days than one page holds", async () => {
    const body = JSON.stringify(contributionsPayload(1, TRUNCATED_COMMIT_TOTAL));
    await env.RAW.put(contributionsKey("2026", LATER), body);

    const replayed = await replayContributions(env.DB, env.RAW, "2026");

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

    const replayed = await replayContributions(env.DB, env.RAW, "2026");

    expect(replayed?.truncated).toBe(false);
    expect(replayed?.rows.commitDays).toBe(4);
  });

  it("keeps a year truncated while one of its quarters is missing", async () => {
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

    const replayed = await replayContributions(env.DB, env.RAW, "2026");

    expect(replayed?.truncated).toBe(true);
    expect(replayed?.rows.commitDays).toBe(3);
  });

  it("recovers a repository a quarter dropped from the months under it", async () => {
    const put = (window: string, payload: unknown) =>
      env.RAW.put(contributionsKey(window, LATER), JSON.stringify(payload));
    await put("2015", commitsPayload([["repo-0", "2015-08-03", 3]], 2));
    await put("2015-Q1", commitsPayload([]));
    await put("2015-Q2", commitsPayload([]));
    await put("2015-Q3", commitsPayload([["repo-0", "2015-08-03", 3]], 2));
    await put("2015-Q4", commitsPayload([]));
    await put("2015-07", commitsPayload([["repo-1", "2015-07-14", 5]]));
    await put("2015-08", commitsPayload([["repo-0", "2015-08-03", 3]]));
    await put("2015-09", commitsPayload([]));

    const replayed = await replayContributions(env.DB, env.RAW, "2015");

    expect(replayed?.truncated).toBe(false);
    expect(await commitDays()).toEqual([
      { repository_id: "R_repo-0", day: "2015-08-03", commit_count: 3 },
      { repository_id: "R_repo-1", day: "2015-07-14", commit_count: 5 },
    ]);
  });

  it("adds up the parts of a day fetched in halves", async () => {
    const put = (window: string, payload: unknown) =>
      env.RAW.put(contributionsKey(window, LATER), JSON.stringify(payload));
    await put("2015-07-14", commitsPayload([["repo-0", "2015-07-14", 6]], 2));
    await put(
      "2015-07-14T00--2015-07-14T12",
      commitsPayload([
        ["repo-0", "2015-07-14", 4],
        ["repo-1", "2015-07-14", 3],
      ]),
    );
    await put(
      "2015-07-14T12--2015-07-15T00",
      commitsPayload([
        ["repo-0", "2015-07-14", 2],
        ["repo-1", "2015-07-14", 2],
      ]),
    );

    const replayed = await replayContributions(env.DB, env.RAW, "2015-07-14");

    expect(replayed?.truncated).toBe(false);
    expect(await commitDays()).toEqual([
      { repository_id: "R_repo-0", day: "2015-07-14", commit_count: 6 },
      { repository_id: "R_repo-1", day: "2015-07-14", commit_count: 5 },
    ]);
  });

  it("replays a narrower window without the rest of its year", async () => {
    await env.RAW.put(
      contributionsKey("2015", LATER),
      JSON.stringify(commitsPayload([["repo-0", "2015-02-03", 1]])),
    );
    await env.RAW.put(
      contributionsKey("2015-07", LATER),
      JSON.stringify(commitsPayload([["repo-1", "2015-07-14", 5]])),
    );

    const replayed = await replayContributions(env.DB, env.RAW, "2015-Q3");

    expect(replayed?.rows.commitDays).toBe(1);
    expect(await commitDays()).toEqual([
      { repository_id: "R_repo-1", day: "2015-07-14", commit_count: 5 },
    ]);
  });

  it("reports a year nothing was archived under", async () => {
    await expect(replayContributions(env.DB, env.RAW, "2011")).resolves.toBeNull();
  });

  it("names the key when the response carries no user", async () => {
    const key = contributionsKey("2026", LATER);
    await env.RAW.put(key, JSON.stringify({ data: { user: null } }));

    await expect(replayContributions(env.DB, env.RAW, "2026")).rejects.toMatchObject({
      key,
      name: "RawValidationError",
    });
  });

  it("changes nothing on a second replay of the same year", async () => {
    await env.RAW.put(contributionsKey("2026", LATER), JSON.stringify(contributionsPayload(2)));
    await replayContributions(env.DB, env.RAW, "2026");

    const replayed = await replayContributions(env.DB, env.RAW, "2026");

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

describe("replayContributionEvents", () => {
  function archiveEvents(
    kind: EventKind,
    window: string,
    fetchedAt: string,
    page: number,
    payload: unknown,
  ): Promise<unknown> {
    return env.RAW.put(
      contributionEventsKey(kind, window, fetchedAt, page),
      JSON.stringify(payload),
    );
  }

  it("normalizes a multi-page fetch and drops reviews on the login's own pull requests", async () => {
    await archiveEvents(
      "pr-reviewed",
      "2015",
      LATER,
      1,
      contributionEventsPayload(
        "pullRequestReviewContributions",
        [reviewedPullRequest(1), reviewedPullRequest(2, { author: { login: "bendrucker" } })],
        { totalCount: 3, endCursor: "Y3Vy" },
      ),
    );
    await archiveEvents(
      "pr-reviewed",
      "2015",
      LATER,
      2,
      contributionEventsPayload("pullRequestReviewContributions", [reviewedPullRequest(3)], {
        totalCount: 3,
      }),
    );

    const replayed = await replayContributionEvents(
      env.DB,
      env.RAW,
      "pr-reviewed",
      "2015",
      "bendrucker",
    );

    expect(replayed).toMatchObject({ fetchedAt: LATER, truncated: false, rows: { reviews: 2 } });
    expect(await count("reviews")).toEqual({ total: 2 });
  });

  it("writes issues and pull requests through the search row builders", async () => {
    await archiveEvents(
      "issue",
      "2015",
      LATER,
      1,
      contributionEventsPayload("issueContributions", [issue(1)]),
    );
    await archiveEvents(
      "pr-authored",
      "2015",
      LATER,
      1,
      contributionEventsPayload("pullRequestContributions", [pullRequest(1)]),
    );

    await replayContributionEvents(env.DB, env.RAW, "issue", "2015", "bendrucker");
    await replayContributionEvents(env.DB, env.RAW, "pr-authored", "2015", "bendrucker");

    expect(await readRow(env.DB, "SELECT id, number, state FROM issues")).toEqual({
      id: "I_1",
      number: 1,
      state: "OPEN",
    });
    expect(await readRow(env.DB, "SELECT id, additions FROM pull_requests")).toEqual({
      id: "PR_1",
      additions: 10,
    });
  });

  it("reads a fetch whose cursor ended short of its count as truncated", async () => {
    await archiveEvents(
      "issue",
      "2015",
      LATER,
      1,
      contributionEventsPayload("issueContributions", [issue(1)], { totalCount: 2 }),
    );

    const replayed = await replayContributionEvents(env.DB, env.RAW, "issue", "2015", "bendrucker");

    expect(replayed?.truncated).toBe(true);
  });

  it.each<{ name: string; quarters: readonly string[]; truncated: boolean }>([
    {
      name: "every quarter archived covers the year",
      quarters: ["Q1", "Q2", "Q3", "Q4"],
      truncated: false,
    },
    {
      name: "a quarter missing leaves it truncated",
      quarters: ["Q1", "Q2", "Q3"],
      truncated: true,
    },
  ])("$name", async ({ quarters, truncated }) => {
    await archiveEvents(
      "issue",
      "2015",
      LATER,
      1,
      contributionEventsPayload("issueContributions", [issue(1)], { totalCount: 5 }),
    );
    for (const [index, quarter] of quarters.entries()) {
      await archiveEvents(
        "issue",
        `2015-${quarter}`,
        LATER,
        1,
        contributionEventsPayload("issueContributions", [issue(index + 2)]),
      );
    }

    const replayed = await replayContributionEvents(env.DB, env.RAW, "issue", "2015", "bendrucker");

    expect(replayed?.truncated).toBe(truncated);
    expect(await count("issues")).toEqual({ total: quarters.length + 1 });
  });

  it("skips a newer fetch that stopped mid-pagination for the last one that finished", async () => {
    await archiveEvents(
      "issue",
      "2015",
      EARLIER,
      1,
      contributionEventsPayload("issueContributions", [issue(1), issue(2)]),
    );
    await archiveEvents(
      "issue",
      "2015",
      LATER,
      1,
      contributionEventsPayload("issueContributions", [issue(1)], {
        totalCount: 2,
        endCursor: "Y3Vy",
      }),
    );

    const replayed = await replayContributionEvents(env.DB, env.RAW, "issue", "2015", "bendrucker");

    expect(replayed).toMatchObject({ fetchedAt: EARLIER, truncated: false });
    expect(await count("issues")).toEqual({ total: 2 });
  });

  it("returns null for a year never crawled", async () => {
    await expect(
      replayContributionEvents(env.DB, env.RAW, "issue", "2011", "bendrucker"),
    ).resolves.toBeNull();
  });
});
