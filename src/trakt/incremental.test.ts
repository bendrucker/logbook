import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyBucket } from "../../test/r2";
import {
  movieRating,
  moviePlay,
  rateLimited,
  stubTrakt,
  traktResponse,
} from "../../test/trakt-fixtures";
import { enqueue, frontierStatus } from "../sync/frontier";
import { advance, readWatermark } from "../sync/state";
import { rewalkTraktYear, syncTrakt } from "./incremental";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const WATERMARK = "2026-09-10T11:00:00.000Z";

beforeEach(async () => {
  env.TRAKT_CLIENT_ID = "client-id";
  await emptyBucket(env.RAW);
});

afterEach(() => {
  delete env.TRAKT_CLIENT_ID;
});

describe("syncTrakt", () => {
  it("sends nothing without a client ID", async () => {
    delete env.TRAKT_CLIENT_ID;
    const trakt = stubTrakt([]);

    await syncTrakt(env, { fetch: trakt.fetch, now: NOW });

    expect(trakt.requests).toHaveLength(0);
  });

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
  });

  it("ends the invocation on a 429 rather than sending the next kind", async () => {
    await advance(env.DB, "trakt-history", WATERMARK, WATERMARK);
    const trakt = stubTrakt([() => rateLimited(60)]);

    await syncTrakt(env, { fetch: trakt.fetch, now: NOW });

    expect(trakt.requests).toHaveLength(1);
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

  it("does nothing without a client ID", async () => {
    delete env.TRAKT_CLIENT_ID;

    expect(await rewalkTraktYear(env, { fetch: stubTrakt([]).fetch, now: NOW })).toBeNull();
  });
});
