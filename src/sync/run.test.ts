import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitDaysPayload,
  contributionsPayload,
  TRUNCATED_COMMIT_TOTAL,
  jsonResponse,
  pullRequest,
  rateLimit,
  requestBody,
  searchResponse,
} from "../../test/github-fixtures";
import { readRow } from "../../test/tables";
import { stubFetch } from "../../test/fetch-stub";
import { searchKey } from "../github/raw";
import { recentRuns } from "./runs";
import { syncContributions, syncWindow } from "./run";
import { readWatermark } from "./state";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const FETCHED_AT = NOW.toISOString();
const WINDOW = {
  key: "2026-09",
  query: "is:pr author:bendrucker",
  through: "2026-09-30T23:59:59Z",
};

beforeEach(async () => {
  env.GITHUB_TOKEN = "token";
  const listed = await env.RAW.list();
  await env.RAW.delete(listed.objects.map((object) => object.key));
});

function sequence(responses: readonly (() => Response | Promise<Response>)[]) {
  const queue = [...responses];
  return stubFetch(() => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("the window asked for more pages than the test staged");
    }
    return next();
  });
}

function count(table: string): Promise<{ total: number } | null> {
  return readRow<{ total: number }>(env.DB, `SELECT COUNT(*) AS total FROM ${table}`);
}

function exhausted(): Response {
  return jsonResponse({
    data: {
      search: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [] },
      rateLimit: rateLimit({ remaining: 5 }),
    },
  });
}

describe("syncWindow", () => {
  it("walks both pages, records the run, and advances the watermark", async () => {
    const { fetch, requests } = sequence([
      () => searchResponse([pullRequest(1)], { endCursor: "cursor" }),
      () => searchResponse([pullRequest(2)]),
    ]);

    const result = await syncWindow(env, "pr-authored", WINDOW, { fetch, now: NOW });

    expect(result).toMatchObject({ pages: 2, truncated: false, error: null, exhausted: false });
    expect(await count("pull_requests")).toEqual({ total: 2 });
    expect(await readWatermark(env.DB, "pr-authored")).toMatchObject({ window: WINDOW.through });
    expect(requests).toHaveLength(2);
  });

  it("archives each page under its own key before the next request", async () => {
    const archived: string[] = [];
    const { fetch } = sequence([
      () => searchResponse([pullRequest(1)], { endCursor: "cursor" }),
      async () => {
        const listed = await env.RAW.list();
        archived.push(...listed.objects.map((object) => object.key));
        return searchResponse([pullRequest(2)]);
      },
    ]);

    await syncWindow(env, "pr-authored", WINDOW, { fetch, now: NOW });

    expect(archived).toEqual([searchKey("pr-authored", WINDOW.key, FETCHED_AT, 1)]);
    const listed = await env.RAW.list();
    expect(listed.objects.map((object) => object.key)).toEqual([
      searchKey("pr-authored", WINDOW.key, FETCHED_AT, 1),
      searchKey("pr-authored", WINDOW.key, FETCHED_AT, 2),
    ]);
  });

  it("keeps the bytes of a page it could not parse and writes no rows", async () => {
    const body = { data: { search: { nodes: "not a list" }, rateLimit: rateLimit() } };
    const { fetch } = sequence([() => jsonResponse(body)]);

    const result = await syncWindow(env, "pr-authored", WINDOW, { fetch, now: NOW });

    expect(result.error).toContain("ResponseValidationError");
    expect(await count("pull_requests")).toEqual({ total: 0 });
    const object = await env.RAW.get(searchKey("pr-authored", WINDOW.key, FETCHED_AT, 1));
    await expect(object?.json()).resolves.toEqual(body);
  });

  it("fails a window whose cursor repeats and archives the repeated page", async () => {
    const { fetch } = sequence([
      () => searchResponse([pullRequest(1)], { endCursor: "cursor" }),
      () => searchResponse([pullRequest(2)], { endCursor: "cursor" }),
    ]);

    const result = await syncWindow(env, "pr-authored", WINDOW, { fetch, now: NOW });

    expect(result).toMatchObject({ pages: 1, exhausted: false });
    expect(result.error).toContain("RepeatedCursorError");
    expect(await readWatermark(env.DB, "pr-authored")).toBeNull();
    expect(await env.RAW.head(searchKey("pr-authored", WINDOW.key, FETCHED_AT, 2))).not.toBeNull();
  });

  it("stops on the rate limit floor without moving the watermark", async () => {
    const { fetch } = sequence([
      () => searchResponse([pullRequest(1)], { endCursor: "cursor" }),
      exhausted,
    ]);

    const result = await syncWindow(env, "pr-authored", WINDOW, { fetch, now: NOW });

    expect(result).toMatchObject({ pages: 1, exhausted: true });
    expect(result.error).toContain("RateLimitExhausted");
    expect(await readWatermark(env.DB, "pr-authored")).toBeNull();
    expect(await count("pull_requests")).toEqual({ total: 1 });
    const [run] = await recentRuns(env.DB, "pr-authored", 1);
    expect(run).toMatchObject({ window: WINDOW.key, startedAt: FETCHED_AT, pages: 1 });
    expect(run?.finishedAt).not.toBeNull();
  });
});

describe("syncContributions", () => {
  it("archives the year, writes commit days, and reports the years GitHub holds", async () => {
    const { fetch } = sequence([() => jsonResponse(contributionsPayload(2))]);

    const result = await syncContributions(env, 2026, { fetch, now: NOW });

    expect(result).toMatchObject({ pages: 1, error: null, contributionYears: [2026, 2025] });
    expect(await count("commit_days")).toEqual({ total: 2 });
    expect(await env.RAW.head(`raw/contributions/2026/${FETCHED_AT}.json`)).not.toBeNull();
  });

  it("records a totals mismatch as a note rather than a failure", async () => {
    const { fetch } = sequence([() => jsonResponse(contributionsPayload(1))]);

    const result = await syncContributions(env, 2026, { fetch, now: NOW });

    expect(result.error).toBeNull();
    expect(result.note).toContain("2026 totals disagree");
    expect(result.note).toContain("pull requests 40 vs 0");
    const [run] = await recentRuns(env.DB, "contributions", 1);
    expect(run?.note).toBe(result.note);
  });

  it("fetches a truncated year again by quarter and keeps each quarter's days", async () => {
    const { fetch, requests } = sequence([
      () => jsonResponse(contributionsPayload(1, TRUNCATED_COMMIT_TOTAL)),
      () => jsonResponse(commitDaysPayload(["2026-02-10"])),
      () => jsonResponse(commitDaysPayload(["2026-05-10"])),
      () => jsonResponse(commitDaysPayload(["2026-08-10"])),
    ]);

    const result = await syncContributions(env, 2026, { fetch, now: NOW });

    expect(result).toMatchObject({ pages: 4, truncated: false, error: null });
    expect(await count("commit_days")).toEqual({ total: 4 });
    expect(await env.RAW.head(`raw/contributions/2026-Q3/${FETCHED_AT}.json`)).not.toBeNull();
    const variables = await Promise.all(
      requests.slice(1).map(async (request) => (await requestBody(request)).variables),
    );
    expect(variables).toMatchObject([
      { from: "2026-01-01T00:00:00.000Z", to: "2026-03-31T23:59:59.000Z" },
      { from: "2026-04-01T00:00:00.000Z", to: "2026-06-30T23:59:59.000Z" },
      { from: "2026-07-01T00:00:00.000Z", to: "2026-09-09T12:00:00.000Z" },
    ]);
  });

  it("reports the quarters it landed when the rate limit stops the walk", async () => {
    const { fetch } = sequence([
      () => jsonResponse(contributionsPayload(1, TRUNCATED_COMMIT_TOTAL)),
      () => jsonResponse(commitDaysPayload(["2026-02-10"])),
      () => {
        const payload = commitDaysPayload(["2026-05-10"]);
        return jsonResponse({ data: { ...payload.data, rateLimit: rateLimit({ remaining: 5 }) } });
      },
    ]);

    const result = await syncContributions(env, 2026, { fetch, now: NOW });

    expect(result).toMatchObject({ pages: 2, truncated: true, exhausted: true });
    expect(result.error).toContain("RateLimitExhausted");
    expect(await readWatermark(env.DB, "contributions")).toBeNull();
    const [run] = await recentRuns(env.DB, "contributions", 1);
    expect(run).toMatchObject({ pages: 2 });
  });

  it("syncs a past year only through that year's end", async () => {
    const { fetch, requests } = sequence([() => jsonResponse(contributionsPayload(1))]);

    await syncContributions(env, 2013, { fetch, now: NOW });

    expect(await readWatermark(env.DB, "contributions")).toMatchObject({
      window: "2013-12-31T23:59:59.000Z",
    });
    const [request] = requests;
    expect(request && (await requestBody(request)).variables).toMatchObject({
      from: "2013-01-01T00:00:00.000Z",
      to: "2013-12-31T23:59:59.000Z",
    });
  });
});
