import { type ExportFile, type ExportRecord, project } from "../src/apple-music/export";

// Records as the import script posts them: every allowed column present, null
// where Apple left the cell empty.

function record(file: ExportFile, values: ExportRecord): ExportRecord {
  return project(file, values);
}

export function playEvent(id: string, overrides: ExportRecord = {}): ExportRecord {
  return record("play-activity", {
    "Event ID": id,
    "Event Type": "PLAY_END",
    "Event Start Timestamp": "2026-09-01T20:00:00.000Z",
    "Event End Timestamp": "2026-09-01T20:04:00.000Z",
    "UTC Offset In Seconds": "-25200",
    "Song Name": "Paranoid Android",
    "Album Name": "OK Computer",
    "Container Type": "ALBUM",
    "Container Name": "OK Computer",
    "Item Type": "ITUNES_STORE_CONTENT",
    "Media Type": "AUDIO",
    "Media Duration In Milliseconds": "386000",
    "Play Duration Milliseconds": "386000",
    "End Reason Type": "NATURAL_END_OF_TRACK",
    ...overrides,
  });
}

export function dailyTrack(overrides: ExportRecord = {}): ExportRecord {
  return record("daily-tracks", {
    "Date Played": "20260901",
    Hours: "13",
    "Track Identifier": "1001",
    "Track Reference": "1097862870",
    "Track Description": "Radiohead - Paranoid Android",
    "Media type": "AUDIO",
    "Play Count": "1",
    "Skip Count": "0",
    "Play Duration Milliseconds": "386000",
    "End Reason Type": "NATURAL_END_OF_TRACK",
    "Source Type": "IPHONE",
    ...overrides,
  });
}

export function libraryTrack(id: number, overrides: ExportRecord = {}): ExportRecord {
  return record("library-tracks", {
    "Track Identifier": id,
    Title: "Paranoid Android",
    Artist: "Radiohead",
    Album: "OK Computer",
    "Album Artist": "Radiohead",
    Genre: "Alternative",
    "Track Year": 1997,
    "Track Duration": 386000,
    "Date Added To Library": "2015-07-01T12:00:00Z",
    Rating: 0,
    "Is Purchased": false,
    "Track Play Count": 12,
    "Skip Count": 0,
    ...overrides,
  });
}

export function favorite(reference: string, overrides: ExportRecord = {}): ExportRecord {
  return record("favorites", {
    "Favorite Type": "Song",
    "Item Reference": reference,
    "Item Description": "Radiohead - Paranoid Android",
    "Last Modified": "2026-01-01T00:00:00Z",
    Preference: "LIKE",
    ...overrides,
  });
}

export function radioEvent(reference: string, overrides: ExportRecord = {}): ExportRecord {
  return record("liked-radio-tracks", {
    Created: "2026-01-01T00:00:00Z",
    "Track Description": "Radiohead - Paranoid Android",
    "Event Type": "LIKE",
    "Item Reference Number": reference,
    ...overrides,
  });
}
