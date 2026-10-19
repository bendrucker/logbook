import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyBucket } from "../../test/r2";
import {
  linkTrakt,
  movieRating,
  moviePlay,
  rateLimited,
  stubTrakt,
  traktResponse,
} from "../../test/trakt-fixtures";
import { enqueue, frontierStatus } from "../sync/frontier";
import { recentRuns } from "../sync/runs";
import { advance, readWatermark } from "../sync/state";
import { traktAuth } from "./auth";
import { rewalkTraktYear, syncTrakt } from "./incremental";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const WATERMARK = "2026-09-10T11:00:00.000Z";

beforeEach(async () => {
  await emptyBucket(env.RAW);
  await linkTrakt(env.DB);
});

describe("syncTrakt", () => {
  it("opens the history window a day behind the watermark, then reads ratings", async () => {
    await advance(env.DB, "trakt-history", WATERMARK, WATERMARK);
    const trakt = stubTrakt([
      () => traktResponse([moviePlay(1, "2026-09-10T10:00:00.000Z")]),
      () => traktResponse([movieRating(8, "2026-09-10T10:30:00.000Z")], null),
    ]);

    await syncTrakt(env, { fetch: trakt.fetch, now: NOW });

    const [history, ratings] = trakt.urls();
    expect(history?.searchParams.get("start_at")).toBe("2026-09-09T11:00:00.000Z");
    expect(history?.searchParams.get("end_at")).toBe(NOW.toISOString());
    expect(ratings?.pathname).toBe("/users/bendrucker/ratings");
    expect((await readWatermark(env.DB, "trakt-history"))?.window).toBe(NOW.toISOString());
  });

  it("skips history with no watermark and still reads ratings", async () => {
    const trakt = stubTrakt([() => traktResponse([], null)]);

    await syncTrakt(env, { fetch: trakt.fetch, now: NOW });

    expect(trakt.urls().map((url) => url.pathname)).toEqual(["/users/bendrucker/ratings"]);
    expect(await readWatermark(env.DB, "trakt-history")).toBeNull();
    expect(await recentRuns(env.DB, "trakt-history", 1)).toMatchObject([
      { outcome: "skipped", reason: "skip.no_watermark" },
    ]);
  });

  it("fails a refused refresh as config and archives no page for it", async () => {
    await env.DB.prepare("DELETE FROM trakt_tokens").run();
    await linkTrakt(env.DB, "2026-09-10T11:00:00.000Z");
    await advance(env.DB, "trakt-history", WATERMARK, WATERMARK);
    const trakt = stubTrakt([() => Response.json({ error: "invalid_grant" }, { status: 401 })]);
    const auth = await traktAuth(env, {
      fetch: trakt.fetch,
      now: NOW,
      wait: () => Promise.resolve(),
    });

    await syncTrakt(env, { fetch: trakt.fetch, now: NOW, auth: auth ?? undefined });

    expect(trakt.urls().map((url) => url.pathname)).toEqual(["/oauth/token"]);
    expect(await recentRuns(env.DB, "trakt-history", 1)).toMatchObject([
      { outcome: "failed", reason: "config" },
    ]);
    expect((await env.RAW.list()).objects).toEqual([]);
  });

  it("ends the invocation on a 429 rather than sending the next kind", async () => {
    await advance(env.DB, "trakt-history", WATERMARK, WATERMARK);
    const trakt = stubTrakt([() => rateLimited(60)]);

    await syncTrakt(env, { fetch: trakt.fetch, now: NOW });

    expect(trakt.requests).toHaveLength(1);
    expect(await recentRuns(env.DB, "trakt-history", 1)).toMatchObject([
      {
        outcome: "rate_limited",
        reason: "rate_limit.upstream",
        resumeAt: "2026-09-10T12:01:00.000Z",
      },
    ]);
    expect(await recentRuns(env.DB, "trakt-ratings", 1)).toMatchObject([
      { outcome: "skipped", reason: "skip.rate_limited" },
    ]);
  });

  it("drains enqueued years with what its own work left", async () => {
    await enqueue(env.DB, "trakt-history", ["2019"], NOW.toISOString());
    const trakt = stubTrakt([
      () => traktResponse([], null),
      () => traktResponse([moviePlay(1, "2019-05-01T20:00:00.000Z")]),
    ]);

    await syncTrakt(env, { fetch: trakt.fetch, now: NOW });

    expect(trakt.urls()[1]?.searchParams.get("start_at")).toBe("2019-01-01T00:00:00.000Z");
    expect((await frontierStatus(env.DB)).get("trakt-history")).toBeUndefined();
  });

  it("leaves history to the drain while backfill years are pending", async () => {
    await advance(env.DB, "trakt-history", "2020-01-01T00:00:00.000Z", WATERMARK);
    await enqueue(env.DB, "trakt-history", ["2020"], NOW.toISOString());
    const trakt = stubTrakt([
      () => traktResponse([], null),
      () => traktResponse([moviePlay(1, "2020-05-01T20:00:00.000Z")]),
    ]);

    await syncTrakt(env, { fetch: trakt.fetch, now: NOW });

    const [ratings, drained] = trakt.urls();
    expect(ratings?.pathname).toBe("/users/bendrucker/ratings");
    expect(drained?.searchParams.get("start_at")).toBe("2020-01-01T00:00:00.000Z");
    expect(trakt.requests).toHaveLength(2);
  });
});

describe("rewalkTraktYear", () => {
  it("re-reads the current year without moving the watermark", async () => {
    await advance(env.DB, "trakt-history", WATERMARK, WATERMARK);
    const trakt = stubTrakt([() => traktResponse([moviePlay(1, "2026-02-01T20:00:00.000Z")])]);

    const run = await rewalkTraktYear(env, { fetch: trakt.fetch, now: NOW });

    expect(run?.error).toBeNull();
    expect(trakt.urls()[0]?.searchParams.get("start_at")).toBe("2026-01-01T00:00:00.000Z");
    expect((await readWatermark(env.DB, "trakt-history"))?.window).toBe(WATERMARK);
  });

  it("records a skip rather than a run until a device login links the account", async () => {
    await env.DB.prepare("DELETE FROM trakt_tokens").run();
    const trakt = stubTrakt([]);

    expect(await rewalkTraktYear(env, { fetch: trakt.fetch, now: NOW })).toBeNull();
    expect(trakt.requests).toEqual([]);
    expect(await recentRuns(env.DB, "trakt-history", 1)).toMatchObject([
      { outcome: "skipped", reason: "skip.missing_secret" },
    ]);
  });
});
