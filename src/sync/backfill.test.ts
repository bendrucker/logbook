import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeClock } from "../../test/clock";
import { stubFetch } from "../../test/fetch-stub";
import {
  contributionsPayload,
  jsonResponse,
  rateLimit,
  repository,
  requestBody,
  searchPayload,
} from "../../test/github-fixtures";
import { replayContributions } from "../normalize";
import { backfill, InvalidMonthError, parseMonth } from "./backfill";
import { BACKFILL_SPACING_MS } from "./budget";
import { enqueue } from "./frontier";
import { readWatermark } from "./state";

const NOW = new Date("2014-06-15T00:00:00.000Z");
const LATER = new Date("2014-06-15T01:00:00.000Z");

beforeEach(async () => {
  env.GITHUB_TOKEN = "token";
  const listed = await env.RAW.list();
  await env.RAW.delete(listed.objects.map((object) => object.key));
});

function stubGitHub(reply: () => Response) {
  const queries: unknown[] = [];
  const { fetch, requests } = stubFetch(async (request) => {
    const { variables } = await requestBody(request.clone());
    queries.push(variables.searchQuery);
    return reply();
  });

  return { fetch, requests, queries };
}

function unitStatus() {
  return env.DB.prepare("SELECT window, parent, status FROM crawl_units ORDER BY window")
    .all<{ window: string; parent: string | null; status: string }>()
    .then(({ results }) => results);
}

describe("parseMonth", () => {
  it("reads a YYYY-MM month", () => {
    expect(parseMonth("2012-12")).toEqual({ year: 2012, month: 12 });
  });

  it.each(["2012", "2012-13", "2012-00", "december", "2012-1"])("rejects %s", (value) => {
    expect(() => parseMonth(value)).toThrow(InvalidMonthError);
  });
});

describe("backfill", () => {
  it("enqueues each month through the present and drains them in order", async () => {
    const { fetch, queries } = stubGitHub(() => jsonResponse(searchPayload([])));

    const result = await backfill(
      env,
      "pr-authored",
      { year: 2012, month: 12 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(result).toMatchObject({ pending: 0, irreducible: [], resumeAt: null, error: null });
    expect(result.windows).toHaveLength(19);
    expect(result.windows.at(0)).toBe("2012-12");
    expect(result.windows.at(-1)).toBe("2014-06");
    expect(queries.at(0)).toBe("is:pr author:bendrucker created:2012-12-01..2012-12-31");
    expect(queries.at(-1)).toBe("is:pr author:bendrucker created:2014-06-01..2014-06-30");
  });

  it("leaves a window that failed pending and retries it on the next call", async () => {
    const failing = stubGitHub(() => jsonResponse({ errors: [{ message: "boom" }] }));

    const failed = await backfill(
      env,
      "issue",
      { year: 2014, month: 5 },
      { fetch: failing.fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(failing.requests).toHaveLength(1);
    expect(failed).toMatchObject({ windows: ["2014-05"], pending: 2, resumeAt: null });
    expect(failed.error).toContain("GraphQLQueryError");

    const { fetch, queries } = stubGitHub(() => jsonResponse(searchPayload([])));
    const retried = await backfill(
      env,
      "issue",
      { year: 2014, month: 5 },
      { fetch, now: LATER, clock: fakeClock().clock },
    );

    expect(retried).toMatchObject({ windows: ["2014-05", "2014-06"], pending: 0, error: null });
    expect(queries.at(0)).toBe("is:issue author:bendrucker created:2014-05-01..2014-05-31");
  });

  it("spaces its requests a second apart", async () => {
    const { fetch, requests } = stubGitHub(() => jsonResponse(searchPayload([])));
    const { clock, waits } = fakeClock();

    await backfill(env, "issue", { year: 2014, month: 1 }, { fetch, now: NOW, clock });

    expect(requests).toHaveLength(6);
    expect(waits).toEqual(Array.from({ length: 5 }, () => BACKFILL_SPACING_MS));
  });

  it("stops on a secondary limit with the window pending and the wait reported", async () => {
    let served = 0;
    const { fetch } = stubGitHub(() => {
      served += 1;
      return served === 1
        ? jsonResponse(searchPayload([]))
        : new Response("You have exceeded a secondary rate limit", {
            status: 429,
            headers: { "Retry-After": "60" },
          });
    });

    const result = await backfill(
      env,
      "issue",
      { year: 2014, month: 1 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(result).toMatchObject({
      windows: ["2014-01", "2014-02"],
      pending: 5,
      resumeAt: "2014-06-15T00:01:00.000Z",
    });
    expect(result.error).toContain("SecondaryRateLimited");
    expect(await unitStatus()).toContainEqual({
      window: "2014-02",
      parent: null,
      status: "pending",
    });
  });

  it("splits a search month past the cap into day ranges", async () => {
    const month = "is:issue author:bendrucker created:2014-05-01..2014-05-31";
    const queries: unknown[] = [];
    const { fetch } = stubFetch(async (request) => {
      const { variables } = await requestBody(request.clone());
      queries.push(variables.searchQuery);
      return jsonResponse(
        searchPayload([], { issueCount: variables.searchQuery === month ? 1001 : 0 }),
      );
    });

    const result = await backfill(
      env,
      "issue",
      { year: 2014, month: 5 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(result).toMatchObject({ pending: 0, irreducible: [], error: null });
    expect(result.windows).toEqual([
      "2014-05",
      "2014-05-01--2014-05-15",
      "2014-05-16--2014-05-31",
      "2014-06",
    ]);
    expect(queries.slice(1, 3)).toEqual([
      "is:issue author:bendrucker created:2014-05-01..2014-05-15",
      "is:issue author:bendrucker created:2014-05-16..2014-05-31",
    ]);
    expect(await unitStatus()).toContainEqual({
      window: "2014-05-16--2014-05-31",
      parent: "2014-05",
      status: "done",
    });
    expect(await unitStatus()).toContainEqual({ window: "2014-05", parent: null, status: "split" });
  });

  it("marks a search hour that still truncates irreducible", async () => {
    const hour = "2014-05-14T05--2014-05-14T06";
    await enqueue(env.DB, "issue", [hour]);
    const { fetch, queries } = stubGitHub(() =>
      jsonResponse(searchPayload([], { issueCount: 1001 })),
    );

    const result = await backfill(
      env,
      "issue",
      { year: 2014, month: 7 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(queries).toEqual([
      "is:issue author:bendrucker created:2014-05-14T05:00:00Z..2014-05-14T05:59:59Z",
    ]);
    expect(result).toMatchObject({ pending: 0, irreducible: [hour] });
  });

  it("leaves the in-progress month's watermark at the present, not at the month's end", async () => {
    const { fetch } = stubGitHub(() => jsonResponse(searchPayload([])));

    await backfill(
      env,
      "issue",
      { year: 2014, month: 6 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    // 2014-06-30 has not happened yet. A watermark there outranks every later
    // advance the monotonic guard sees, so the hourly sync would go quiet for
    // the rest of the month.
    expect(await readWatermark(env.DB, "issue")).toMatchObject({
      window: NOW.toISOString(),
    });
  });

  it("walks nothing for a start in the future", async () => {
    const { fetch, requests } = stubGitHub(() => jsonResponse(searchPayload([])));

    const result = await backfill(
      env,
      "issue",
      { year: 2099, month: 1 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ windows: [], pending: 0 });
  });
});

// A window wider than `WIDEST_WHOLE_DAYS` lists only its first repository, the
// way a window past `maxRepositories` drops the rest, and reports the totals
// that give the loss away.
const COMMITS = [
  { name: "repo-0", day: "2014-02-10", count: 2 },
  { name: "repo-1", day: "2014-02-20", count: 3 },
  { name: "repo-2", day: "2014-05-05", count: 1 },
];
const WIDEST_WHOLE_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

function contributionsSource(options: { refuseAfter?: number; truncateAll?: boolean } = {}) {
  const windows: string[] = [];
  const { fetch, requests } = stubFetch(async (request) => {
    const { variables } = await requestBody(request.clone());
    const from = String(variables.from);
    const to = String(variables.to);
    windows.push(`${from}..${to}`);

    const within = COMMITS.filter(({ day }) => {
      const at = `${day}T07:00:00.000Z`;
      return at >= from && at <= to;
    });
    const narrow = Date.parse(to) - Date.parse(from) < WIDEST_WHOLE_DAYS * DAY_MS;
    const listed = narrow && options.truncateAll !== true ? within : within.slice(0, 1);
    const payload = contributionsPayload(0, 0, {
      totalCommitContributions: within.reduce((total, { count }) => total + count, 0),
      totalRepositoriesWithContributedCommits:
        options.truncateAll === true ? within.length + 1 : within.length,
      commitContributionsByRepository: listed.map(({ name, day, count }) => ({
        repository: repository(name),
        contributions: {
          totalCount: count,
          nodes: [{ commitCount: count, occurredAt: `${day}T07:00:00Z` }],
        },
      })),
    });
    const remaining =
      options.refuseAfter !== undefined && windows.length >= options.refuseAfter ? 100 : 4999;
    return jsonResponse({ data: { ...payload.data, rateLimit: rateLimit({ remaining }) } });
  });
  return { fetch, requests, windows };
}

function commitDays() {
  return env.DB.prepare(
    "SELECT repository_id, day, commit_count FROM commit_days ORDER BY repository_id, day",
  )
    .all()
    .then(({ results }) => results);
}

describe("backfill contributions", () => {
  it("splits a year down the calendar until every window comes back whole", async () => {
    const { fetch, windows } = contributionsSource();

    const result = await backfill(
      env,
      "contributions",
      { year: 2014, month: 1 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(result).toMatchObject({ pending: 0, irreducible: [], error: null });
    expect(result.windows).toEqual(["2014", "2014-Q1", "2014-01", "2014-02", "2014-03", "2014-Q2"]);
    expect(windows.at(-1)).toBe("2014-04-01T00:00:00.000Z..2014-06-15T00:00:00.000Z");
    expect(await unitStatus()).toEqual([
      { window: "2014", parent: null, status: "split" },
      { window: "2014-01", parent: "2014-Q1", status: "done" },
      { window: "2014-02", parent: "2014-Q1", status: "done" },
      { window: "2014-03", parent: "2014-Q1", status: "done" },
      { window: "2014-Q1", parent: "2014", status: "split" },
      { window: "2014-Q2", parent: "2014", status: "done" },
    ]);
    expect(await commitDays()).toEqual([
      { repository_id: "R_repo-0", day: "2014-02-10", commit_count: 2 },
      { repository_id: "R_repo-1", day: "2014-02-20", commit_count: 3 },
      { repository_id: "R_repo-2", day: "2014-05-05", commit_count: 1 },
    ]);
  });

  it("resumes after a budget stop without refetching the windows that finished", async () => {
    const first = contributionsSource({ refuseAfter: 3 });

    const stopped = await backfill(
      env,
      "contributions",
      { year: 2014, month: 1 },
      { fetch: first.fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(first.requests).toHaveLength(3);
    expect(stopped).toMatchObject({ pending: 3 });
    expect(stopped.error).toContain("BudgetRefused");
    expect(stopped.resumeAt).not.toBeNull();
    // The year and its first quarter split, and only January has landed.
    expect(await readWatermark(env.DB, "contributions")).toMatchObject({
      window: "2014-01-31T23:59:59.000Z",
    });

    const second = contributionsSource();
    const resumed = await backfill(
      env,
      "contributions",
      { year: 2014, month: 1 },
      { fetch: second.fetch, now: LATER, clock: fakeClock().clock },
    );

    expect(resumed).toMatchObject({ windows: ["2014-02", "2014-03", "2014-Q2"], pending: 0 });
    expect(second.requests).toHaveLength(3);
    expect(await readWatermark(env.DB, "contributions")).toMatchObject({
      window: LATER.toISOString(),
    });
  });

  it("marks a window still truncated at the hour irreducible", async () => {
    await enqueue(env.DB, "contributions", ["2014-02-10"]);
    const { fetch, requests } = contributionsSource({ truncateAll: true });

    const result = await backfill(
      env,
      "contributions",
      { year: 2099, month: 1 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    // The day, its two halves, and the twelve hours of each half.
    expect(requests).toHaveLength(27);
    expect(result.pending).toBe(0);
    expect(result.irreducible).toHaveLength(24);
    expect(result.irreducible.at(0)).toBe("2014-02-10T00--2014-02-10T01");
    expect(await commitDays()).toEqual([
      { repository_id: "R_repo-0", day: "2014-02-10", commit_count: 2 },
    ]);
  });

  it("rebuilds from the archive the same commit days the live run wrote", async () => {
    const { fetch } = contributionsSource();
    await backfill(
      env,
      "contributions",
      { year: 2014, month: 1 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );
    const live = await commitDays();
    await env.DB.prepare("DELETE FROM commit_days").run();

    const replayed = await replayContributions(env.DB, env.RAW, "2014");

    expect(replayed?.truncated).toBe(false);
    expect(await commitDays()).toEqual(live);
  });
});
