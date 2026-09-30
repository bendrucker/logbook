import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyBucket } from "../../test/r2";
import {
  movieRating,
  moviePlay,
  rateLimited,
  stubTrakt,
  traktResponse,
} from "../../test/trakt-fixtures";
import { readWatermark } from "../sync/state";
import { backfillTrakt } from "./backfill";

const NOW = new Date("2026-09-10T12:00:00.000Z");

beforeEach(async () => {
  await emptyBucket(env.RAW);
});

function play(year: number) {
  return () => traktResponse([moviePlay(year, `${year}-06-01T20:00:00.000Z`)]);
}

describe("backfillTrakt", () => {
  it("finds the oldest play on the last page and walks each year since", async () => {
    const trakt = stubTrakt([
      () => traktResponse([moviePlay(9, "2026-01-01T20:00:00.000Z")], { page: 1, pageCount: 3 }),
      () => traktResponse([moviePlay(1, "2024-03-01T20:00:00.000Z")], { page: 3, pageCount: 3 }),
      play(2024),
      play(2025),
      play(2026),
    ]);

    const result = await backfillTrakt(env, "trakt-history", null, {
      fetch: trakt.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({ windows: ["2024", "2025", "2026"], pending: 0, error: null });
    expect(trakt.urls()[1]?.searchParams.get("page")).toBe("3");
    expect((await readWatermark(env.DB, "trakt-history"))?.window).toBe(NOW.toISOString());
  });

  it("starts at the year of `from` without discovery", async () => {
    const trakt = stubTrakt([play(2025), play(2026)]);

    const result = await backfillTrakt(
      env,
      "trakt-history",
      { year: 2025, month: 4 },
      { fetch: trakt.fetch, now: NOW },
    );

    expect(result.windows).toEqual(["2025", "2026"]);
  });

  it("resumes from the years already enqueued", async () => {
    const stopped = stubTrakt([() => rateLimited(30)]);
    const first = await backfillTrakt(
      env,
      "trakt-history",
      { year: 2025, month: 1 },
      { fetch: stopped.fetch, now: NOW },
    );
    expect(first).toMatchObject({ pending: 2, resumeAt: "2026-09-10T12:00:30.000Z" });

    const trakt = stubTrakt([play(2025), play(2026)]);
    const second = await backfillTrakt(env, "trakt-history", null, {
      fetch: trakt.fetch,
      now: NOW,
    });

    expect(second).toMatchObject({ windows: ["2025", "2026"], pending: 0 });
  });

  it("reports a stop during discovery as pending", async () => {
    const trakt = stubTrakt([() => rateLimited(30)]);

    const result = await backfillTrakt(env, "trakt-history", null, {
      fetch: trakt.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({ pending: 1, resumeAt: "2026-09-10T12:00:30.000Z" });
  });

  it("answers a failed discovery with its error rather than throwing", async () => {
    const trakt = stubTrakt([() => new Response("down", { status: 503 })]);

    const result = await backfillTrakt(env, "trakt-history", null, {
      fetch: trakt.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({ pending: 1, resumeAt: null });
    expect(result.error).toContain("503");
  });

  it("reads ratings in one pass", async () => {
    const trakt = stubTrakt([
      () => traktResponse([movieRating(7, "2026-01-01T00:00:00.000Z")], null),
    ]);

    const result = await backfillTrakt(env, "trakt-ratings", null, {
      fetch: trakt.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({ windows: ["all"], pages: 1, pending: 0, error: null });
  });
});
