import { unhandled } from "../unhandled";
import type {
  DailyTrackRecord,
  FavoriteRecord,
  LibraryTrackRecord,
  LikedRadioTrackRecord,
  PlayActivityRecord,
} from "./schema";

export const APPLE_SOURCE = "apple-export";

// Last.fm's scrobble rule, so a play means the same thing whichever source
// reported it: a track longer than 30 seconds, played for half its length or
// four minutes, whichever comes first.
const MIN_TRACK_MS = 30_000;
const MAX_REQUIRED_MS = 240_000;

// What tracks match on across sources that don't share an ID.
export function nameKey(name: string | null): string {
  return name === null ? "" : name.trim().toLowerCase();
}

export interface MusicPlay {
  source: string;
  id: string;
  playedAt: string;
  utcOffsetSeconds: number | null;
  title: string;
  titleKey: string;
  album: string | null;
  albumKey: string;
  durationMs: number;
  playedMs: number;
  endReason: string | null;
  containerType: string | null;
  containerName: string | null;
}

// Null for an event that is not a listen: a start, a lyrics view, a video, a
// radio stream with no track, or a track skipped before the rule counts it.
// Events from before mid-2016 carry no event type and stand for finished plays.
export function playRow(record: PlayActivityRecord): MusicPlay | null {
  const eventType = record["Event Type"];
  if (eventType !== null && eventType !== "PLAY_END") {
    return null;
  }
  if (record["Item Type"] !== "ITUNES_STORE_CONTENT" || record["Media Type"] !== "AUDIO") {
    return null;
  }

  const title = record["Song Name"];
  const startedAt = instant(record["Event Start Timestamp"]);
  const durationMs = integer(record["Media Duration In Milliseconds"]);
  const reportedMs = integer(record["Play Duration Milliseconds"]);
  if (title === null || startedAt === null || durationMs === null || reportedMs === null) {
    return null;
  }

  const playedMs = Math.min(reportedMs, durationMs);
  if (durationMs <= MIN_TRACK_MS || playedMs < Math.min(durationMs / 2, MAX_REQUIRED_MS)) {
    return null;
  }

  const album = record["Album Name"];
  return {
    source: APPLE_SOURCE,
    id: record["Event ID"],
    playedAt: startedAt,
    utcOffsetSeconds: integer(record["UTC Offset In Seconds"]),
    title,
    titleKey: nameKey(title),
    album,
    albumKey: nameKey(album),
    durationMs,
    playedMs,
    endReason: record["End Reason Type"],
    containerType: record["Container Type"],
    containerName: record["Container Name"],
  };
}

export interface DailyTrack {
  id: string;
  playedOn: string;
  trackId: string;
  device: string;
  hours: string;
  trackReference: string | null;
  description: string | null;
  artist: string | null;
  artistKey: string;
  title: string | null;
  titleKey: string;
  playCount: number | null;
  skipCount: number | null;
  playedMs: number | null;
  endReason: string | null;
}

export function dailyTrackRow(record: DailyTrackRecord, id: string): DailyTrack {
  const date = record["Date Played"];
  const description = record["Track Description"];
  const { artist, title } = splitDescription(description);
  return {
    id,
    playedOn: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    trackId: record["Track Identifier"],
    device: record["Source Type"] ?? "",
    hours: record.Hours ?? "",
    trackReference: record["Track Reference"],
    description,
    artist,
    artistKey: nameKey(artist),
    title,
    titleKey: nameKey(title),
    playCount: integer(record["Play Count"]),
    skipCount: integer(record["Skip Count"]),
    playedMs: integer(record["Play Duration Milliseconds"]),
    endReason: record["End Reason Type"],
  };
}

export interface LibraryTrack {
  trackId: number;
  catalogId: number | null;
  title: string | null;
  titleKey: string;
  artist: string | null;
  artistKey: string;
  album: string | null;
  albumKey: string;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  durationMs: number | null;
  addedAt: string | null;
  rating: number | null;
  loved: boolean;
  purchased: boolean | null;
  playCount: number | null;
  skipCount: number | null;
}

export function libraryTrackRow(record: LibraryTrackRecord): LibraryTrack {
  return {
    trackId: record["Track Identifier"],
    catalogId: record["Apple Music Track Identifier"],
    title: record.Title,
    titleKey: nameKey(record.Title),
    artist: record.Artist,
    artistKey: nameKey(record.Artist),
    album: record.Album,
    albumKey: nameKey(record.Album),
    albumArtist: record["Album Artist"],
    genre: record.Genre,
    year: record["Track Year"],
    durationMs: record["Track Duration"],
    addedAt: instant(record["Date Added To Library"]),
    rating: record.Rating,
    // Older libraries mark a loved track with the like rating, newer ones with
    // the favorite status.
    loved: record["Favorite Status - Track"] === true || record["Track Like Rating"] === "liked",
    purchased: record["Is Purchased"],
    playCount: record["Track Play Count"],
    skipCount: record["Skip Count"],
  };
}

export type PreferenceType = "song" | "album" | "artist" | "playlist";

export interface Preference {
  source: "favorites" | "radio";
  type: PreferenceType;
  reference: string;
  description: string | null;
  artistKey: string;
  titleKey: string;
  preference: "like" | "dislike";
  changedAt: string | null;
}

// A song or an album is described as `Artist - Name`, an artist by its name.
// Null for a favorite type nothing matches against.
export function favoriteRow(record: FavoriteRecord): Preference | null {
  const type = preferenceType(record["Favorite Type"]);
  if (type === null) {
    return null;
  }

  const description = record["Item Description"];
  const named = favoriteNames(type, description);
  return {
    source: "favorites",
    type,
    reference: record["Item Reference"],
    description,
    artistKey: nameKey(named.artist),
    titleKey: nameKey(named.title),
    preference: record.Preference === "LIKE" ? "like" : "dislike",
    changedAt: instant(record["Last Modified"]),
  };
}

// The radio records a like, a like of the track that seeded a station, or a
// ban. Null for any other event.
export function likedRadioTrackRow(record: LikedRadioTrackRecord): Preference | null {
  const preference = RADIO_EVENTS[record["Event Type"]];
  if (preference === undefined) {
    return null;
  }

  const description = record["Track Description"];
  const { artist, title } = splitDescription(description);
  return {
    source: "radio",
    type: "song",
    reference: record["Item Reference Number"],
    description,
    artistKey: nameKey(artist),
    titleKey: nameKey(title),
    preference,
    changedAt: instant(record.Created),
  };
}

function favoriteNames(
  type: PreferenceType,
  description: string | null,
): { artist: string | null; title: string | null } {
  switch (type) {
    case "artist":
      return { artist: description, title: null };
    case "playlist":
      return { artist: null, title: null };
    case "song":
    case "album":
      return splitDescription(description);
    default:
      throw unhandled(type);
  }
}

const RADIO_EVENTS: Record<string, Preference["preference"]> = {
  LIKE: "like",
  SEED_LIKE: "like",
  BAN: "dislike",
};

function preferenceType(value: string): PreferenceType | null {
  switch (value) {
    case "Song":
      return "song";
    case "Album":
      return "album";
    case "Artist":
      return "artist";
    case "Playlist":
      return "playlist";
    default:
      return null;
  }
}

// Splits on the first ` - `, since a song title carries one far more often
// than an artist name does ("Song - Remastered 2011").
export function splitDescription(description: string | null): {
  artist: string | null;
  title: string | null;
} {
  const separator = description?.indexOf(" - ") ?? -1;
  if (description === null || separator < 0) {
    return { artist: null, title: description };
  }
  return {
    artist: description.slice(0, separator),
    title: description.slice(separator + " - ".length),
  };
}

// Hex SHA-256 of the record, which validation hands over with its keys in the
// schema's order whichever order the page wrote them in.
export async function recordId(record: DailyTrackRecord): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(record)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function integer(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function instant(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
