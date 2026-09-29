import { bigint, integer, text, timestamp } from "./columns";
import type { LakeTable } from "./table";

// `released` is a calendar date rather than an instant, so it stays text like
// `commit_days.day`.
export const traktTitles: LakeTable = {
  name: "trakt_titles",
  path: "trakt/v1/titles",
  key: ["type", "trakt_id"],
  columns: [
    text("type"),
    integer("trakt_id"),
    text("slug"),
    text("title"),
    integer("year"),
    integer("show_trakt_id"),
    integer("season"),
    integer("number"),
    text("imdb_id"),
    integer("tmdb_id"),
    integer("tvdb_id"),
    text("released"),
    timestamp("first_aired"),
    integer("runtime"),
    text("genres"),
    text("certification"),
    text("network"),
    text("country"),
    text("language"),
    text("status"),
    timestamp("fetched_at"),
  ],
};

export const traktPlays: LakeTable = {
  name: "trakt_plays",
  path: "trakt/v1/plays",
  key: ["id"],
  columns: [
    bigint("id"),
    timestamp("watched_at"),
    text("action"),
    text("type"),
    integer("trakt_id"),
    integer("show_trakt_id"),
  ],
};

export const traktRatings: LakeTable = {
  name: "trakt_ratings",
  path: "trakt/v1/ratings",
  key: ["type", "trakt_id"],
  columns: [
    text("type"),
    integer("trakt_id"),
    integer("rating"),
    timestamp("rated_at"),
    integer("show_trakt_id"),
  ],
};
