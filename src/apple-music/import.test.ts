import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { dailyTrack, playEvent } from "../../test/apple-music-fixtures";
import { emptyBucket } from "../../test/r2";
import type { ExportRecord } from "./export";
import { replayAppleMusicFile } from "./replay";

const TOKEN = "admin-token";

function importPage(query: string, records: ExportRecord[], token = TOKEN): Promise<Response> {
  return exports.default.fetch(`https://logbook.test/admin/import/apple-music?${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(records),
  });
}

function finish(query = "export=2026-10-03"): Promise<Response> {
  return exports.default.fetch(`https://logbook.test/admin/import/apple-music/finish?${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

async function countPlays(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM music_plays").first<{ n: number }>();
  return row?.n ?? 0;
}

const PLAYS = "export=2026-10-03&file=play-activity&page=1";

beforeEach(async () => {
  env.ADMIN_TOKEN = TOKEN;
  await emptyBucket(env.RAW);
});

afterEach(() => {
  delete env.ADMIN_TOKEN;
});

describe("POST /admin/import/apple-music", () => {
  it("answers 404 while no admin token is set", async () => {
    delete env.ADMIN_TOKEN;

    expect((await importPage(PLAYS, [playEvent("e1")])).status).toBe(404);
  });

  it("answers 401 to the wrong token", async () => {
    expect((await importPage(PLAYS, [playEvent("e1")], "wrong")).status).toBe(401);
  });

  test.each<{ name: string; query: string; records: ExportRecord[] }>([
    {
      name: "an export that is not a date",
      query: "export=latest&file=play-activity&page=1",
      records: [playEvent("e1")],
    },
    {
      name: "an unknown file",
      query: "export=2026-10-03&file=wishlist&page=1",
      records: [playEvent("e1")],
    },
    {
      name: "page zero",
      query: "export=2026-10-03&file=play-activity&page=0",
      records: [playEvent("e1")],
    },
    {
      name: "a column outside the allowlist",
      query: PLAYS,
      records: [{ ...playEvent("e1"), "Client IP Address": "192.0.2.1" }],
    },
    { name: "a record of another file", query: PLAYS, records: [dailyTrack()] },
  ])("refuses $name without archiving it", async ({ query, records }) => {
    const response = await importPage(query, records);

    expect(response.status).toBe(400);
    expect((await env.RAW.list()).objects).toEqual([]);
    expect(await countPlays()).toBe(0);
  });

  it("archives the page and writes the plays it counts", async () => {
    const response = await importPage(PLAYS, [
      playEvent("e1"),
      playEvent("e2", { "Event Type": "PLAY_START" }),
    ]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      key: "raw/apple-music/2026-10-03/play-activity/0001.json",
      archived: true,
      records: 2,
      rowsChanged: 1,
    });
    expect(await countPlays()).toBe(1);
  });

  it("changes nothing when the same page arrives again", async () => {
    await importPage(PLAYS, [playEvent("e1")]);

    const response = await importPage(PLAYS, [playEvent("e1")]);

    expect(await response.json()).toMatchObject({ archived: false, rowsChanged: 0 });
  });

  it("refuses a page archived with a different body", async () => {
    await importPage(PLAYS, [playEvent("e1")]);

    const response = await importPage(PLAYS, [playEvent("e2")]);

    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT id FROM music_plays")
        .all()
        .then(({ results }) => results),
    ).toEqual([{ id: "e1" }]);
  });

  it("writes rows a replay of the archive reproduces", async () => {
    await importPage(PLAYS, [playEvent("e1")]);
    await importPage("export=2026-10-03&file=play-activity&page=2", [playEvent("e2")]);
    await env.DB.prepare("DELETE FROM music_plays").run();

    const replay = await replayAppleMusicFile(env.DB, env.RAW, "2026-10-03", "play-activity");

    expect(replay).toEqual({ pages: 2, rowsChanged: 2 });
    expect(await countPlays()).toBe(2);
  });
});

describe("POST /admin/import/apple-music/finish", () => {
  it("resolves artists and builds the candidate tracks", async () => {
    await importPage(PLAYS, [playEvent("e1")]);
    await importPage("export=2026-10-03&file=daily-tracks&page=1", [dailyTrack()]);

    const response = await finish();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      artistsChanged: 1,
      tracksChanged: 1,
      plays: 1,
      unresolved: 0,
      tracks: 1,
    });
  });

  it("refuses a finish without the export", async () => {
    expect((await finish("")).status).toBe(400);
  });
});
