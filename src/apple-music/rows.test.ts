import { describe, expect, it, test } from "vitest";
import {
  dailyTrack,
  favorite,
  libraryTrack,
  playEvent,
  radioEvent,
} from "../../test/apple-music-fixtures";
import type { ExportRecord } from "./export";
import {
  dailyTrackRow,
  favoriteRow,
  libraryTrackRow,
  likedRadioTrackRow,
  playRow,
  splitDescription,
} from "./rows";
import {
  dailyTrackRecord,
  favoriteRecord,
  libraryTrackRecord,
  likedRadioTrackRecord,
  playActivityRecord,
} from "./schema";

const EXPORT_ID = "2026-10-03";

function play(overrides: ExportRecord) {
  return playRow(playActivityRecord.parse(playEvent("e1", overrides)));
}

describe("playRow", () => {
  it("reads a finished play", () => {
    expect(play({})).toEqual({
      source: "apple-export",
      id: "e1",
      playedAt: "2026-09-01T20:00:00.000Z",
      utcOffsetSeconds: -25200,
      title: "Paranoid Android",
      titleKey: "paranoid android",
      album: "OK Computer",
      albumKey: "ok computer",
      durationMs: 386000,
      playedMs: 386000,
      endReason: "NATURAL_END_OF_TRACK",
      containerType: "ALBUM",
      containerName: "OK Computer",
    });
  });

  test.each<{ name: string; overrides: ExportRecord; counts: boolean }>([
    {
      name: "half of a short track",
      overrides: {
        "Media Duration In Milliseconds": "200000",
        "Play Duration Milliseconds": "100000",
      },
      counts: true,
    },
    {
      name: "just under half of a short track",
      overrides: {
        "Media Duration In Milliseconds": "200000",
        "Play Duration Milliseconds": "99999",
      },
      counts: false,
    },
    {
      name: "four minutes of a long track",
      overrides: {
        "Media Duration In Milliseconds": "1200000",
        "Play Duration Milliseconds": "240000",
      },
      counts: true,
    },
    {
      name: "under four minutes of a long track",
      overrides: {
        "Media Duration In Milliseconds": "1200000",
        "Play Duration Milliseconds": "239999",
      },
      counts: false,
    },
    {
      name: "a track of 30 seconds",
      overrides: {
        "Media Duration In Milliseconds": "30000",
        "Play Duration Milliseconds": "30000",
      },
      counts: false,
    },
    { name: "an untyped event from before 2016", overrides: { "Event Type": null }, counts: true },
    { name: "a play start", overrides: { "Event Type": "PLAY_START" }, counts: false },
    { name: "a lyrics view", overrides: { "Event Type": "LYRIC_DISPLAY" }, counts: false },
    { name: "a video", overrides: { "Media Type": "VIDEO" }, counts: false },
    { name: "a radio stream", overrides: { "Item Type": "STREAM" }, counts: false },
    { name: "no song name", overrides: { "Song Name": null }, counts: false },
    { name: "no start time", overrides: { "Event Start Timestamp": null }, counts: false },
    { name: "no duration", overrides: { "Media Duration In Milliseconds": null }, counts: false },
  ])("counts $name: $counts", ({ overrides, counts }) => {
    expect(play(overrides) !== null).toBe(counts);
  });

  it("caps the time played at the track's length", () => {
    expect(play({ "Play Duration Milliseconds": "2491200000" })?.playedMs).toBe(386000);
  });
});

describe("dailyTrackRow", () => {
  it("reads the date and splits the description", () => {
    const row = dailyTrackRow(dailyTrackRecord.parse(dailyTrack()), "hash");

    expect(row).toMatchObject({
      id: "hash",
      playedOn: "2026-09-01",
      artist: "Radiohead",
      artistKey: "radiohead",
      title: "Paranoid Android",
      titleKey: "paranoid android",
      playCount: 1,
    });
  });

  it("writes a missing device and hour as empty", () => {
    const row = dailyTrackRow(
      dailyTrackRecord.parse(dailyTrack({ "Source Type": null, Hours: null })),
      "hash",
    );

    expect(row).toMatchObject({ device: "", hours: "" });
  });
});

describe("libraryTrackRow", () => {
  test.each<{ name: string; overrides: ExportRecord; loved: boolean }>([
    { name: "a favorite", overrides: { "Favorite Status - Track": true }, loved: true },
    { name: "a liked rating", overrides: { "Track Like Rating": "liked" }, loved: true },
    { name: "a disliked rating", overrides: { "Track Like Rating": "disliked" }, loved: false },
    { name: "neither", overrides: {}, loved: false },
  ])("reads $name as loved: $loved", ({ overrides, loved }) => {
    expect(
      libraryTrackRow(libraryTrackRecord.parse(libraryTrack(1, overrides)), EXPORT_ID).loved,
    ).toBe(loved);
  });
});

describe("favoriteRow", () => {
  test.each<{ name: string; overrides: ExportRecord; expected: object }>([
    {
      name: "a song",
      overrides: {},
      expected: {
        type: "song",
        artistKey: "radiohead",
        titleKey: "paranoid android",
        preference: "like",
      },
    },
    {
      name: "an album",
      overrides: { "Favorite Type": "Album", "Item Description": "Radiohead - OK Computer" },
      expected: { type: "album", artistKey: "radiohead", titleKey: "ok computer" },
    },
    {
      name: "an artist",
      overrides: {
        "Favorite Type": "Artist",
        "Item Description": "Radiohead",
        Preference: "DISLIKE",
      },
      expected: { type: "artist", artistKey: "radiohead", titleKey: "", preference: "dislike" },
    },
    {
      name: "a playlist",
      overrides: { "Favorite Type": "Playlist", "Item Description": "Road Trip - Summer" },
      expected: { type: "playlist", artistKey: "", titleKey: "" },
    },
  ])("reads $name", ({ overrides, expected }) => {
    expect(favoriteRow(favoriteRecord.parse(favorite("r1", overrides)), EXPORT_ID)).toMatchObject(
      expected,
    );
  });

  it("skips a type nothing matches against", () => {
    expect(
      favoriteRow(favoriteRecord.parse(favorite("r1", { "Favorite Type": "Station" })), EXPORT_ID),
    ).toBeNull();
  });
});

describe("likedRadioTrackRow", () => {
  test.each<[string, string | null]>([
    ["LIKE", "like"],
    ["SEED_LIKE", "like"],
    ["BAN", "dislike"],
    ["SKIP", null],
  ])("reads %s as %s", (eventType, preference) => {
    const row = likedRadioTrackRow(
      likedRadioTrackRecord.parse(radioEvent("r1", { "Event Type": eventType })),
      EXPORT_ID,
    );

    expect(row?.preference ?? null).toBe(preference);
  });
});

describe("splitDescription", () => {
  test.each<{ description: string | null; artist: string | null; title: string | null }>([
    { description: "Radiohead - Paranoid Android", artist: "Radiohead", title: "Paranoid Android" },
    {
      description: "Queen - Bohemian Rhapsody - Remastered 2011",
      artist: "Queen",
      title: "Bohemian Rhapsody - Remastered 2011",
    },
    { description: "Untitled", artist: null, title: "Untitled" },
    { description: null, artist: null, title: null },
  ])("splits $description", ({ description, artist, title }) => {
    expect(splitDescription(description)).toEqual({ artist, title });
  });
});
