import { bigint, boolean, integer, text, timestamp } from "./columns";
import type { LakeTable } from "./table";

export const musicPlays: LakeTable = {
  name: "music_plays",
  path: "music/v1/plays",
  key: ["source", "id"],
  columns: [
    text("source"),
    text("id"),
    timestamp("played_at"),
    integer("utc_offset_seconds"),
    text("title"),
    text("title_key"),
    text("artist"),
    text("artist_key"),
    text("artist_match"),
    text("album"),
    text("album_key"),
    integer("duration_ms"),
    integer("played_ms"),
    text("end_reason"),
    text("container_type"),
    text("container_name"),
  ],
};

export const musicTracks: LakeTable = {
  name: "music_tracks",
  path: "music/v1/tracks",
  key: ["artist_key", "title_key"],
  columns: [
    text("artist_key"),
    text("title_key"),
    text("artist"),
    text("title"),
    text("album"),
    text("album_key"),
    integer("plays"),
    timestamp("first_played_at"),
    timestamp("last_played_at"),
    boolean("loved"),
    integer("stars"),
    boolean("disliked"),
  ],
};

// `played_on` is the day as Apple's rollup reports it, so it stays text.
export const appleMusicDailyTracks: LakeTable = {
  name: "apple_music_daily_tracks",
  path: "music/v1/apple_daily_tracks",
  key: ["id"],
  columns: [
    text("id"),
    text("played_on"),
    text("track_id"),
    text("device"),
    text("hours"),
    text("track_reference"),
    text("description"),
    text("artist"),
    text("artist_key"),
    text("title"),
    text("title_key"),
    integer("play_count"),
    integer("skip_count"),
    integer("played_ms"),
    text("end_reason"),
  ],
};

export const appleMusicLibraryTracks: LakeTable = {
  name: "apple_music_library_tracks",
  path: "music/v1/apple_library_tracks",
  key: ["track_id"],
  columns: [
    integer("track_id"),
    bigint("catalog_id"),
    text("title"),
    text("title_key"),
    text("artist"),
    text("artist_key"),
    text("album"),
    text("album_key"),
    text("album_artist"),
    text("genre"),
    integer("year"),
    integer("duration_ms"),
    timestamp("added_at"),
    integer("rating"),
    boolean("loved"),
    boolean("purchased"),
    integer("play_count"),
    integer("skip_count"),
    text("export_id"),
  ],
};

export const appleMusicPreferences: LakeTable = {
  name: "apple_music_preferences",
  path: "music/v1/apple_preferences",
  key: ["source", "type", "reference"],
  columns: [
    text("source"),
    text("type"),
    text("reference"),
    text("description"),
    text("artist_key"),
    text("title_key"),
    text("preference"),
    timestamp("changed_at"),
    text("export_id"),
  ],
};
