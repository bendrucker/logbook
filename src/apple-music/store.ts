import { type BindValue, upsertWriter } from "../store/upsert";
import type { DailyTrack, LibraryTrack, MusicPlay, Preference } from "./rows";

const playColumns = [
  "source",
  "id",
  "played_at",
  "utc_offset_seconds",
  "title",
  "title_key",
  "album",
  "album_key",
  "duration_ms",
  "played_ms",
  "end_reason",
  "container_type",
  "container_name",
] as const;

// The artist columns are left out, so an import of the same events keeps the
// artist `resolveArtists` found for them.
export const upsertPlays = upsertWriter(
  { table: "music_plays", columns: playColumns, conflict: ["source", "id"] },
  (row: MusicPlay): Record<(typeof playColumns)[number], BindValue> => ({
    source: row.source,
    id: row.id,
    played_at: row.playedAt,
    utc_offset_seconds: row.utcOffsetSeconds,
    title: row.title,
    title_key: row.titleKey,
    album: row.album,
    album_key: row.albumKey,
    duration_ms: row.durationMs,
    played_ms: row.playedMs,
    end_reason: row.endReason,
    container_type: row.containerType,
    container_name: row.containerName,
  }),
);

const dailyColumns = [
  "id",
  "played_on",
  "track_id",
  "device",
  "hours",
  "track_reference",
  "description",
  "artist",
  "artist_key",
  "title",
  "title_key",
  "play_count",
  "skip_count",
  "played_ms",
  "end_reason",
] as const;

export const upsertDailyTracks = upsertWriter(
  {
    table: "apple_music_daily_tracks",
    columns: dailyColumns,
    conflict: ["id"],
  },
  (row: DailyTrack): Record<(typeof dailyColumns)[number], BindValue> => ({
    id: row.id,
    played_on: row.playedOn,
    track_id: row.trackId,
    device: row.device,
    hours: row.hours,
    track_reference: row.trackReference,
    description: row.description,
    artist: row.artist,
    artist_key: row.artistKey,
    title: row.title,
    title_key: row.titleKey,
    play_count: row.playCount,
    skip_count: row.skipCount,
    played_ms: row.playedMs,
    end_reason: row.endReason,
  }),
);

const libraryColumns = [
  "track_id",
  "catalog_id",
  "title",
  "title_key",
  "artist",
  "artist_key",
  "album",
  "album_key",
  "album_artist",
  "genre",
  "year",
  "duration_ms",
  "added_at",
  "rating",
  "loved",
  "purchased",
  "play_count",
  "skip_count",
  "export_id",
] as const;

export const upsertLibraryTracks = upsertWriter(
  { table: "apple_music_library_tracks", columns: libraryColumns, conflict: ["track_id"] },
  (row: LibraryTrack): Record<(typeof libraryColumns)[number], BindValue> => ({
    track_id: row.trackId,
    catalog_id: row.catalogId,
    title: row.title,
    title_key: row.titleKey,
    artist: row.artist,
    artist_key: row.artistKey,
    album: row.album,
    album_key: row.albumKey,
    album_artist: row.albumArtist,
    genre: row.genre,
    year: row.year,
    duration_ms: row.durationMs,
    added_at: row.addedAt,
    rating: row.rating,
    loved: Number(row.loved),
    purchased: row.purchased === null ? null : Number(row.purchased),
    play_count: row.playCount,
    skip_count: row.skipCount,
    export_id: row.exportId,
  }),
);

const preferenceColumns = [
  "source",
  "type",
  "reference",
  "description",
  "artist_key",
  "title_key",
  "preference",
  "changed_at",
  "export_id",
] as const;

export const upsertPreferences = upsertWriter(
  {
    table: "apple_music_preferences",
    columns: preferenceColumns,
    conflict: ["source", "type", "reference"],
  },
  (row: Preference): Record<(typeof preferenceColumns)[number], BindValue> => ({
    source: row.source,
    type: row.type,
    reference: row.reference,
    description: row.description,
    artist_key: row.artistKey,
    title_key: row.titleKey,
    preference: row.preference,
    changed_at: row.changedAt,
    export_id: row.exportId,
  }),
);
