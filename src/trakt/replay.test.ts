import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyBucket } from "../../test/r2";
import { emptyTables } from "../../test/tables";
import {
  episodePlay,
  moviePlay,
  rateLimited,
  stubTrakt,
  traktResponse,
} from "../../test/trakt-fixtures";
import { RequestCap } from "./client";
import { replayTraktWindow } from "./replay";
import { syncHistoryWindow, yearWindow } from "./sync";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const WINDOW = yearWindow(2026, NOW, false);

beforeEach(async () => {
  env.TRAKT_CLIENT_ID = "client-id";
  await emptyBucket(env.RAW);
});

async function snapshot() {
  const tables = ["trakt_titles", "trakt_plays", "trakt_ratings"];
  const rows = await Promise.all(
    tables.map(async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results),
  );
  return Object.fromEntries(tables.map((table, index) => [table, rows[index]]));
}

function sync(replies: readonly (() => Response)[], now: Date) {
  return syncHistoryWindow(env, WINDOW, {
    fetch: stubTrakt(replies).fetch,
    now,
    requests: new RequestCap(10),
  });
}

describe("replayTraktWindow", () => {
  it("rebuilds from R2 the rows the live sync wrote", async () => {
    await sync(
      [
        () =>
          traktResponse([episodePlay(2, "2026-09-02T20:00:00.000Z")], { page: 1, pageCount: 2 }),
        () => traktResponse([moviePlay(1, "2026-09-01T20:00:00.000Z")], { page: 2, pageCount: 2 }),
      ],
      NOW,
    );
    const live = await snapshot();
    await emptyTables(env.DB);

    const replay = await replayTraktWindow(env.DB, env.RAW, "trakt-history", WINDOW.key);

    expect(replay).toMatchObject({ complete: true, rows: { plays: 2, titles: 3 } });
    expect(await snapshot()).toEqual(live);
  });

  it("prefers an older fetch that finished over a newer one that stopped", async () => {
    const finished = await sync(
      [() => traktResponse([moviePlay(1, "2026-09-01T20:00:00.000Z")])],
      NOW,
    );
    await sync(
      [
        () => traktResponse([moviePlay(2, "2026-09-02T20:00:00.000Z")], { page: 1, pageCount: 2 }),
        () => rateLimited(60),
      ],
      new Date("2026-09-10T13:00:00.000Z"),
    );
    await emptyTables(env.DB);

    const replay = await replayTraktWindow(env.DB, env.RAW, "trakt-history", WINDOW.key);

    expect(replay).toMatchObject({ fetchedAt: finished.fetchedAt, complete: true });
  });

  it("passes over a newer fetch whose 200 failed validation", async () => {
    const finished = await sync(
      [() => traktResponse([moviePlay(1, "2026-09-01T20:00:00.000Z")])],
      NOW,
    );
    await sync([() => new Response("[{}]", { status: 200 })], new Date("2026-09-10T13:00:00.000Z"));
    await emptyTables(env.DB);

    const replay = await replayTraktWindow(env.DB, env.RAW, "trakt-history", WINDOW.key);

    expect(replay).toMatchObject({ fetchedAt: finished.fetchedAt, complete: true });
  });

  it("reads a fetch of an empty window as complete", async () => {
    await sync([() => traktResponse([])], NOW);

    const replay = await replayTraktWindow(env.DB, env.RAW, "trakt-history", WINDOW.key);

    expect(replay).toMatchObject({ complete: true, rows: { plays: 0 } });
  });

  it("finds nothing under a window never fetched", async () => {
    expect(await replayTraktWindow(env.DB, env.RAW, "trakt-history", "1999")).toBeNull();
  });
});
