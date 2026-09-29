import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyBucket } from "../../test/r2";
import { readRow } from "../../test/tables";
import {
  episodePlay,
  movieRating,
  moviePlay,
  rateLimited,
  stubTrakt,
  traktResponse,
} from "../../test/trakt-fixtures";
import { recentRuns } from "../sync/runs";
import { readWatermark } from "../sync/state";
import { RequestCap } from "./client";
import { readMetadata } from "./raw";
import { syncHistoryWindow, syncRatings, watchedWindow, yearWindow } from "./sync";

const NOW = new Date("2026-09-10T12:00:00.000Z");

beforeEach(async () => {
  env.TRAKT_CLIENT_ID = "client-id";
  await emptyBucket(env.RAW);
});

afterEach(() => {
  delete env.TRAKT_CLIENT_ID;
});

async function archivedKeys(): Promise<string[]> {
  const listed = await env.RAW.list({ prefix: "raw/trakt/" });
  return listed.objects.map((object) => object.key);
}

function count(table: string): Promise<{ total: number } | null> {
  return readRow<{ total: number }>(env.DB, `SELECT COUNT(*) AS total FROM ${table}`);
}

describe("syncHistoryWindow", () => {
  it("pages to the count Trakt reports, archiving each page before its rows", async () => {
    const trakt = stubTrakt([
      () => traktResponse([episodePlay(3, "2026-09-02T20:00:00.000Z")], { page: 1, pageCount: 2 }),
      () => traktResponse([moviePlay(1, "2026-09-01T20:00:00.000Z")], { page: 2, pageCount: 2 }),
    ]);
    const window = watchedWindow("2026-09-01T00:00:00.000Z", NOW.toISOString());

    const run = await syncHistoryWindow(env, window, {
      fetch: trakt.fetch,
      now: NOW,
      requests: new RequestCap(10),
    });

    expect(run).toMatchObject({ pages: 2, error: null, resumeAt: null, cost: 0 });
    expect(trakt.urls().map((url) => [url.pathname, Object.fromEntries(url.searchParams)])).toEqual(
      [1, 2].map((page) => [
        "/users/bendrucker/history",
        {
          start_at: "2026-09-01T00:00:00.000Z",
          end_at: NOW.toISOString(),
          extended: "full",
          page: String(page),
          limit: "250",
        },
      ]),
    );
    const prefix = `raw/trakt/trakt-history/${window.key}/${run.fetchedAt}`;
    expect(await archivedKeys()).toEqual([`${prefix}/0001.json`, `${prefix}/0002.json`]);
    const first = await env.RAW.head(`${prefix}/0001.json`);
    expect(readMetadata(first?.customMetadata)).toEqual({
      status: 200,
      pagination: { page: 1, limit: 250, pageCount: 2, itemCount: 1 },
      failure: null,
    });
    expect(await count("trakt_plays")).toEqual({ total: 2 });
    expect(await count("trakt_titles")).toEqual({ total: 3 });
    expect((await readWatermark(env.DB, "trakt-history"))?.window).toBe(NOW.toISOString());
  });

  it("finishes a window Trakt reports as zero pages on its first request", async () => {
    const trakt = stubTrakt([() => traktResponse([])]);

    const run = await syncHistoryWindow(env, yearWindow(2026, NOW, true), {
      fetch: trakt.fetch,
      now: NOW,
      requests: new RequestCap(10),
    });

    expect(run).toMatchObject({ pages: 1, error: null });
    expect(trakt.requests).toHaveLength(1);
    expect((await readWatermark(env.DB, "trakt-history"))?.window).toBe(NOW.toISOString());
  });

  it("leaves the watermark alone for a pass that repairs a covered year", async () => {
    const trakt = stubTrakt([() => traktResponse([moviePlay(1, "2026-03-01T20:00:00.000Z")])]);

    await syncHistoryWindow(env, yearWindow(2026, NOW, false), {
      fetch: trakt.fetch,
      now: NOW,
      requests: new RequestCap(10),
    });

    expect(await count("trakt_plays")).toEqual({ total: 1 });
    expect(await readWatermark(env.DB, "trakt-history")).toBeNull();
  });

  it("reads a year through the next year's first instant", () => {
    expect(yearWindow(2019, NOW, true)).toEqual({
      key: "2019",
      startAt: "2019-01-01T00:00:00.000Z",
      endAt: "2020-01-01T00:00:00.000Z",
      through: "2020-01-01T00:00:00.000Z",
    });
  });

  it("stops on a 429, archives its body, and reports when to resume", async () => {
    const trakt = stubTrakt([
      () => traktResponse([moviePlay(2, "2026-09-02T20:00:00.000Z")], { page: 1, pageCount: 2 }),
      () => rateLimited(120),
    ]);
    const window = watchedWindow("2026-09-01T00:00:00.000Z", NOW.toISOString());

    const run = await syncHistoryWindow(env, window, {
      fetch: trakt.fetch,
      now: NOW,
      requests: new RequestCap(10),
    });

    expect(run.resumeAt).toBe("2026-09-10T12:02:00.000Z");
    expect(run.error).not.toBeNull();
    const failed = await env.RAW.get(
      `raw/trakt/trakt-history/${window.key}/${run.fetchedAt}/0002.json`,
    );
    expect(await failed?.text()).toBe('{"error":"rate limited"}');
    expect(readMetadata(failed?.customMetadata).status).toBe(429);
    expect(await readWatermark(env.DB, "trakt-history")).toBeNull();
    const [recorded] = await recentRuns(env.DB, "trakt-history", 1);
    expect(recorded).toMatchObject({ pages: 1, cost: 0 });
  });

  it("stops at the request cap without sending the request past it", async () => {
    const trakt = stubTrakt([
      () => traktResponse([moviePlay(2, "2026-09-02T20:00:00.000Z")], { page: 1, pageCount: 2 }),
    ]);

    const run = await syncHistoryWindow(env, yearWindow(2026, NOW, true), {
      fetch: trakt.fetch,
      now: NOW,
      requests: new RequestCap(1),
    });

    expect(trakt.requests).toHaveLength(1);
    expect(run.resumeAt).toBe(NOW.toISOString());
    expect(await readWatermark(env.DB, "trakt-history")).toBeNull();
  });
});

describe("syncRatings", () => {
  it("reads the whole list, unpaginated, and records the read as the watermark", async () => {
    const trakt = stubTrakt([
      () => traktResponse([movieRating(8, "2026-08-01T00:00:00.000Z")], null),
    ]);

    const run = await syncRatings(env, {
      fetch: trakt.fetch,
      now: NOW,
      requests: new RequestCap(10),
    });

    expect(trakt.urls()[0]?.pathname).toBe("/users/bendrucker/ratings");
    expect(await archivedKeys()).toEqual([
      `raw/trakt/trakt-ratings/all/${run.fetchedAt}/0001.json`,
    ]);
    expect(await count("trakt_ratings")).toEqual({ total: 1 });
    expect((await readWatermark(env.DB, "trakt-ratings"))?.window).toBe(run.fetchedAt);
  });

  it("replaces a changed rating in place", async () => {
    const options = { now: NOW, requests: new RequestCap(10) };
    await syncRatings(env, {
      ...options,
      fetch: stubTrakt([() => traktResponse([movieRating(6, "2026-08-01T00:00:00.000Z")], null)])
        .fetch,
    });
    await syncRatings(env, {
      ...options,
      now: new Date("2026-09-10T13:00:00.000Z"),
      fetch: stubTrakt([() => traktResponse([movieRating(9, "2026-09-10T00:00:00.000Z")], null)])
        .fetch,
    });

    expect(
      await readRow(env.DB, "SELECT rating, rated_at FROM trakt_ratings WHERE trakt_id = 1"),
    ).toEqual({ rating: 9, rated_at: "2026-09-10T00:00:00.000Z" });
  });
});
