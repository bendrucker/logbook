import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  dailyTrack,
  favorite,
  libraryTrack,
  playEvent,
  radioEvent,
} from "../../test/apple-music-fixtures";
import type { ExportFile, ExportRecord } from "./export";
import { readPage } from "./import";
import { refreshTracks } from "./tracks";

const EXPORT_ID = "2026-10-03";

async function load(
  file: ExportFile,
  records: ExportRecord[],
  exportId = EXPORT_ID,
): Promise<void> {
  await readPage(file, JSON.stringify(records)).write(env.DB, exportId);
}

async function plays(): Promise<
  { id: string; artist: string | null; artist_match: string | null }[]
> {
  const { results } = await env.DB.prepare(
    "SELECT id, artist, artist_match FROM music_plays ORDER BY id",
  ).all<{ id: string; artist: string | null; artist_match: string | null }>();
  return results;
}

interface TrackRow {
  artist: string | null;
  title: string;
  plays: number;
  first_played_at: string;
  last_played_at: string;
  loved: number;
  stars: number | null;
  disliked: number;
}

async function track(): Promise<TrackRow | null> {
  return env.DB.prepare(
    `SELECT artist, title, plays, first_played_at, last_played_at, loved, stars, disliked
    FROM music_tracks WHERE artist_key = 'radiohead' AND title_key = 'paranoid android'`,
  ).first<TrackRow>();
}

// A play on 2026-09-01 at 20:00 UTC, 13:00 that day in UTC-7.
const PLAY = playEvent("e1");

describe("refreshTracks", () => {
  describe("artist resolution", () => {
    it("takes the daily rollup's artist from the day of the play", async () => {
      await load("play-activity", [PLAY]);
      await load("daily-tracks", [
        dailyTrack(),
        dailyTrack({
          "Date Played": "20200101",
          "Track Description": "Cover Band - Paranoid Android",
        }),
      ]);

      await refreshTracks(env.DB, EXPORT_ID);

      expect(await plays()).toEqual([{ id: "e1", artist: "Radiohead", artist_match: "same-day" }]);
    });

    it("takes the library's artist for the same title and album", async () => {
      await load("play-activity", [PLAY]);
      await load("library-tracks", [libraryTrack(1)]);

      await refreshTracks(env.DB, EXPORT_ID);

      expect(await plays()).toEqual([{ id: "e1", artist: "Radiohead", artist_match: "library" }]);
    });

    it("takes the daily rollup's only artist for the title on another day", async () => {
      await load("play-activity", [PLAY]);
      await load("daily-tracks", [dailyTrack({ "Date Played": "20200101" })]);

      await refreshTracks(env.DB, EXPORT_ID);

      expect(await plays()).toEqual([{ id: "e1", artist: "Radiohead", artist_match: "title" }]);
    });

    it("leaves the artist unset when every rung names two", async () => {
      await load("play-activity", [PLAY]);
      await load("daily-tracks", [
        dailyTrack(),
        dailyTrack({
          "Track Identifier": "1002",
          "Track Description": "Cover Band - Paranoid Android",
        }),
      ]);

      const refresh = await refreshTracks(env.DB, EXPORT_ID);

      expect(await plays()).toEqual([{ id: "e1", artist: null, artist_match: null }]);
      expect(refresh.unresolved).toBe(1);
    });

    it("keeps a resolved artist when the plays are imported again", async () => {
      await load("play-activity", [PLAY]);
      await load("library-tracks", [libraryTrack(1)]);
      await refreshTracks(env.DB, EXPORT_ID);

      await load("play-activity", [PLAY]);

      expect(await plays()).toEqual([{ id: "e1", artist: "Radiohead", artist_match: "library" }]);
    });
  });

  it("counts a track's plays and names it from the latest", async () => {
    await load("play-activity", [
      playEvent("e1", { "Event Start Timestamp": "2024-01-01T00:00:00Z" }),
      playEvent("e2", { "Song Name": "PARANOID ANDROID" }),
    ]);
    await load("library-tracks", [libraryTrack(1)]);

    const refresh = await refreshTracks(env.DB, EXPORT_ID);

    expect(await track()).toEqual({
      artist: "Radiohead",
      title: "PARANOID ANDROID",
      plays: 2,
      first_played_at: "2024-01-01T00:00:00.000Z",
      last_played_at: "2026-09-01T20:00:00.000Z",
      loved: 0,
      stars: null,
      disliked: 0,
    });
    expect(refresh).toMatchObject({ plays: 2, tracks: 1, tracksChanged: 1 });
  });

  it("changes nothing on a second refresh", async () => {
    await load("play-activity", [PLAY]);
    await load("library-tracks", [libraryTrack(1)]);
    await refreshTracks(env.DB, EXPORT_ID);

    expect(await refreshTracks(env.DB, EXPORT_ID)).toMatchObject({
      artistsChanged: 0,
      tracksChanged: 0,
    });
  });

  describe("signals", () => {
    it.each<{
      name: string;
      file: ExportFile;
      records: ExportRecord[];
      expected: Partial<TrackRow>;
    }>([
      {
        name: "a library favorite as loved",
        file: "library-tracks",
        records: [libraryTrack(2, { "Favorite Status - Track": true })],
        expected: { loved: 1 },
      },
      {
        name: "a favorited song as loved",
        file: "favorites",
        records: [favorite("r1")],
        expected: { loved: 1 },
      },
      {
        name: "a radio like as loved",
        file: "liked-radio-tracks",
        records: [radioEvent("r1")],
        expected: { loved: 1 },
      },
      {
        name: "a library rating as stars",
        file: "library-tracks",
        records: [libraryTrack(2, { Rating: 80 })],
        expected: { stars: 4 },
      },
      {
        name: "a radio ban as disliked",
        file: "liked-radio-tracks",
        records: [radioEvent("r1", { "Event Type": "BAN" })],
        expected: { disliked: 1, loved: 0 },
      },
      {
        name: "a disliked artist as disliked",
        file: "favorites",
        records: [
          favorite("r1", {
            "Favorite Type": "Artist",
            "Item Description": "Radiohead",
            Preference: "DISLIKE",
          }),
        ],
        expected: { disliked: 1 },
      },
      {
        name: "a disliked album as disliked",
        file: "favorites",
        records: [
          favorite("r1", {
            "Favorite Type": "Album",
            "Item Description": "Radiohead - OK Computer",
            Preference: "DISLIKE",
          }),
        ],
        expected: { disliked: 1 },
      },
      {
        name: "a disliked other album as nothing",
        file: "favorites",
        records: [
          favorite("r1", {
            "Favorite Type": "Album",
            "Item Description": "Radiohead - Kid A",
            Preference: "DISLIKE",
          }),
        ],
        expected: { disliked: 0 },
      },
      {
        name: "a liked artist as nothing",
        file: "favorites",
        records: [favorite("r1", { "Favorite Type": "Artist", "Item Description": "Radiohead" })],
        expected: { loved: 0 },
      },
    ])("reads $name", async ({ file, records, expected }) => {
      await load("play-activity", [PLAY]);
      await load("library-tracks", [libraryTrack(1)]);
      await load(file, records);

      await refreshTracks(env.DB, EXPORT_ID);

      expect(await track()).toMatchObject(expected);
    });
  });

  it("drops a track once its plays resolve to another artist", async () => {
    await load("play-activity", [PLAY]);
    await load("daily-tracks", [
      dailyTrack({ "Track Description": "Cover Band - Paranoid Android" }),
    ]);
    await refreshTracks(env.DB, EXPORT_ID);

    await env.DB.prepare("DELETE FROM apple_music_daily_tracks").run();
    await load("daily-tracks", [dailyTrack()]);
    await refreshTracks(env.DB, EXPORT_ID);

    const { results } = await env.DB.prepare("SELECT artist FROM music_tracks").all();
    expect(results).toEqual([{ artist: "Radiohead" }]);
  });

  it("drops a library track and a preference a newer export no longer holds", async () => {
    await load("play-activity", [PLAY]);
    await load("library-tracks", [
      libraryTrack(1),
      libraryTrack(2, { "Favorite Status - Track": true }),
    ]);
    await load("favorites", [favorite("r1")]);
    await refreshTracks(env.DB, EXPORT_ID);

    await load("library-tracks", [libraryTrack(1)], "2026-12-01");
    await load(
      "favorites",
      [favorite("r2", { "Favorite Type": "Artist", "Item Description": "Portishead" })],
      "2026-12-01",
    );
    await refreshTracks(env.DB, "2026-12-01");

    expect(await track()).toMatchObject({ artist: "Radiohead", loved: 0 });
  });

  it("keeps the library when the export named landed none of it", async () => {
    await load("play-activity", [PLAY]);
    await load("library-tracks", [libraryTrack(1, { "Favorite Status - Track": true })]);

    await refreshTracks(env.DB, "2099-01-01");

    expect(await track()).toMatchObject({ loved: 1 });
  });

  it("keeps a newer export's library row when an older export arrives later", async () => {
    await load("play-activity", [PLAY]);
    await load(
      "library-tracks",
      [libraryTrack(1, { "Favorite Status - Track": true })],
      "2026-12-01",
    );
    await load("library-tracks", [libraryTrack(1)]);

    await refreshTracks(env.DB, "2026-12-01");

    expect(await track()).toMatchObject({ loved: 1 });
  });
});
