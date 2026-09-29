import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeClock } from "../../test/clock";
import { stubFetch } from "../../test/fetch-stub";
import {
  contributionsPayload,
  jsonResponse,
  pullRequest,
  rateLimit,
  requestBody,
  searchPayload,
} from "../../test/github-fixtures";
import { readRow } from "../../test/tables";
import { enqueue, frontierStatus } from "./frontier";
import { syncIncremental } from "./incremental";
import { recentRuns } from "./runs";
import { advance, readWatermark } from "./state";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const WATERMARK = "2026-09-09T10:00:00.000Z";

beforeEach(async () => {
  env.GITHUB_TOKEN = "token";
  const listed = await env.RAW.list();
  await env.RAW.delete(listed.objects.map((object) => object.key));
});

// Every kind issues the same POST, so the search string each request carries is
// what tells one kind's window from another's.
function stubGitHub(replies: readonly (() => Response)[]) {
  const queue = [...replies];
  const queries: unknown[] = [];
  const { fetch, requests } = stubFetch(async (request) => {
    const { variables } = await requestBody(request.clone());
    queries.push(variables.searchQuery);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("the sync asked for more pages than the test staged");
    }
    return next();
  });

  return { fetch, requests, queries };
}

function count(table: string): Promise<{ total: number } | null> {
  return readRow<{ total: number }>(env.DB, `SELECT COUNT(*) AS total FROM ${table}`);
}

describe("syncIncremental", () => {
  it("walks a two-page window off the watermark and advances it", async () => {
    await advance(env.DB, "pr-authored", WATERMARK, WATERMARK);
    const { fetch } = stubGitHub([
      () => jsonResponse(searchPayload([pullRequest(1)], { endCursor: "cursor" })),
      () => jsonResponse(searchPayload([pullRequest(2)])),
      () => jsonResponse(contributionsPayload(1)),
    ]);

    await syncIncremental(env, { fetch, now: NOW });

    expect(await count("pull_requests")).toEqual({ total: 2 });
    expect(await readWatermark(env.DB, "pr-authored")).toEqual({
      window: NOW.toISOString(),
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- vitest types asymmetric matchers as `any`
      updatedAt: expect.any(String),
    });
    const [run] = await recentRuns(env.DB, "pr-authored", 1);
    expect(run).toMatchObject({
      window: "updated:2026-09-09T09:00:00.000Z..2026-09-09T12:00:00.000Z",
      pages: 2,
    });
  });

  it("opens the window an hour behind the watermark", async () => {
    await advance(env.DB, "pr-authored", WATERMARK, WATERMARK);
    const { fetch, queries } = stubGitHub([
      () => jsonResponse(searchPayload([])),
      () => jsonResponse(contributionsPayload(1)),
    ]);

    await syncIncremental(env, { fetch, now: NOW });

    expect(queries[0]).toBe(
      "is:pr author:bendrucker updated:2026-09-09T09:00:00.000Z..2026-09-09T12:00:00.000Z",
    );
  });

  it("splits a window matching more than the cap into halves, earliest first", async () => {
    await advance(env.DB, "pr-authored", WATERMARK, WATERMARK);
    const { fetch, queries } = stubGitHub([
      () => jsonResponse(searchPayload([pullRequest(1)], { issueCount: 1001 })),
      () => jsonResponse(searchPayload([pullRequest(2)])),
      () => jsonResponse(searchPayload([pullRequest(3)])),
      () => jsonResponse(contributionsPayload(1)),
    ]);

    await syncIncremental(env, { fetch, now: NOW });

    expect(queries.slice(0, 3)).toEqual([
      "is:pr author:bendrucker updated:2026-09-09T09:00:00.000Z..2026-09-09T12:00:00.000Z",
      "is:pr author:bendrucker updated:2026-09-09T09:00:00.000Z..2026-09-09T10:30:00.000Z",
      "is:pr author:bendrucker updated:2026-09-09T10:30:00.000Z..2026-09-09T12:00:00.000Z",
    ]);
    expect(await count("pull_requests")).toEqual({ total: 3 });
    expect(await readWatermark(env.DB, "pr-authored")).toMatchObject({
      window: NOW.toISOString(),
    });
  });

  it("holds the watermark at the last half that landed", async () => {
    await advance(env.DB, "pr-authored", WATERMARK, WATERMARK);
    const { fetch, requests } = stubGitHub([
      () => jsonResponse(searchPayload([], { issueCount: 1001 })),
      () => jsonResponse(searchPayload([])),
      () => jsonResponse({ errors: [{ message: "boom" }] }),
      () => jsonResponse(contributionsPayload(1)),
    ]);

    await syncIncremental(env, { fetch, now: NOW });

    expect(await readWatermark(env.DB, "pr-authored")).toMatchObject({
      window: "2026-09-09T10:30:00.000Z",
    });
    expect(requests).toHaveLength(4);
  });

  it("skips a kind with no watermark and still reads the current year", async () => {
    const { fetch, requests } = stubGitHub([() => jsonResponse(contributionsPayload(1))]);

    await syncIncremental(env, { fetch, now: NOW });

    expect(requests).toHaveLength(1);
    expect(await count("commit_days")).toEqual({ total: 1 });
    expect(await recentRuns(env.DB, "pr-authored", 1)).toEqual([]);
  });

  it("stops the invocation when the budget refuses a kind", async () => {
    await advance(env.DB, "pr-authored", WATERMARK, WATERMARK);
    await advance(env.DB, "issue", WATERMARK, WATERMARK);
    const { fetch, requests } = stubGitHub([
      () =>
        jsonResponse({
          data: {
            search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
            rateLimit: rateLimit({ remaining: env.RATE_FLOOR_SYNC - 1 }),
          },
        }),
    ]);

    await syncIncremental(env, { fetch, now: NOW });

    expect(requests).toHaveLength(1);
    expect(await readWatermark(env.DB, "pr-authored")).toMatchObject({
      window: NOW.toISOString(),
    });
    const [refused] = await recentRuns(env.DB, "issue", 1);
    expect(refused).toMatchObject({ pages: 0, cost: 0 });
    expect(refused?.error).toContain("BudgetRefused");
    expect(await readWatermark(env.DB, "issue")).toMatchObject({ window: WATERMARK });
    expect(await recentRuns(env.DB, "contributions", 1)).toEqual([]);
  });

  it("drains backfill windows with what the incremental work left", async () => {
    await enqueue(env.DB, "issue", ["2014-01"]);
    const { fetch, queries } = stubGitHub([
      () => jsonResponse(contributionsPayload(1)),
      () => jsonResponse(searchPayload([])),
    ]);

    await syncIncremental(env, { fetch, now: NOW, clock: fakeClock().clock });

    expect(queries.at(-1)).toBe("is:issue author:bendrucker created:2014-01-01..2014-01-31");
    expect((await frontierStatus(env.DB)).get("issue")).toBeUndefined();
  });

  it("leaves backfill windows pending below the backfill floor", async () => {
    await enqueue(env.DB, "issue", ["2014-01"]);
    const payload = contributionsPayload(1);
    const { fetch, requests } = stubGitHub([
      () =>
        jsonResponse({
          data: {
            ...payload.data,
            rateLimit: rateLimit({ remaining: env.RATE_FLOOR_BACKFILL - 1 }),
          },
        }),
    ]);

    await syncIncremental(env, { fetch, now: NOW, clock: fakeClock().clock });

    expect(requests).toHaveLength(1);
    expect((await frontierStatus(env.DB)).get("issue")).toEqual({ pending: 1, irreducible: [] });
  });
});
