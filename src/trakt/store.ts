import { type BindValue, upsertWriter } from "../store/upsert";

export type TitleType = "movie" | "show" | "season" | "episode";

export interface Title {
  type: TitleType;
  traktId: number;
  slug: string | null;
  title: string | null;
  year: number | null;
  showTraktId: number | null;
  season: number | null;
  number: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  released: string | null;
  firstAired: string | null;
  runtime: number | null;
  genres: string | null;
  certification: string | null;
  network: string | null;
  country: string | null;
  language: string | null;
  status: string | null;
  fetchedAt: string;
}

export interface Play {
  id: number;
  watchedAt: string;
  action: "scrobble" | "checkin" | "watch";
  type: "movie" | "episode";
  traktId: number;
  showTraktId: number | null;
}

export interface Rating {
  type: TitleType;
  traktId: number;
  rating: number;
  ratedAt: string;
  showTraktId: number | null;
}

const titleColumns = [
  "type",
  "trakt_id",
  "slug",
  "title",
  "year",
  "show_trakt_id",
  "season",
  "number",
  "imdb_id",
  "tmdb_id",
  "tvdb_id",
  "released",
  "first_aired",
  "runtime",
  "genres",
  "certification",
  "network",
  "country",
  "language",
  "status",
  "fetched_at",
] as const;

// `fetched_at` is written but not compared, as on `repositories`: it moves on
// every fetch, so comparing it would make every upsert a change.
export const upsertTitles = upsertWriter(
  {
    table: "trakt_titles",
    columns: titleColumns,
    conflict: ["type", "trakt_id"],
    compared: titleColumns.filter(
      (column) => column !== "type" && column !== "trakt_id" && column !== "fetched_at",
    ),
  },
  (row: Title): Record<(typeof titleColumns)[number], BindValue> => ({
    type: row.type,
    trakt_id: row.traktId,
    slug: row.slug,
    title: row.title,
    year: row.year,
    show_trakt_id: row.showTraktId,
    season: row.season,
    number: row.number,
    imdb_id: row.imdbId,
    tmdb_id: row.tmdbId,
    tvdb_id: row.tvdbId,
    released: row.released,
    first_aired: row.firstAired,
    runtime: row.runtime,
    genres: row.genres,
    certification: row.certification,
    network: row.network,
    country: row.country,
    language: row.language,
    status: row.status,
    fetched_at: row.fetchedAt,
  }),
);

const playColumns = ["id", "watched_at", "action", "type", "trakt_id", "show_trakt_id"] as const;

export const upsertPlays = upsertWriter(
  { table: "trakt_plays", columns: playColumns, conflict: ["id"] },
  (row: Play): Record<(typeof playColumns)[number], BindValue> => ({
    id: row.id,
    watched_at: row.watchedAt,
    action: row.action,
    type: row.type,
    trakt_id: row.traktId,
    show_trakt_id: row.showTraktId,
  }),
);

const ratingColumns = ["type", "trakt_id", "rating", "rated_at", "show_trakt_id"] as const;

export const upsertRatings = upsertWriter(
  { table: "trakt_ratings", columns: ratingColumns, conflict: ["type", "trakt_id"] },
  (row: Rating): Record<(typeof ratingColumns)[number], BindValue> => ({
    type: row.type,
    trakt_id: row.traktId,
    rating: row.rating,
    rated_at: row.ratedAt,
    show_trakt_id: row.showTraktId,
  }),
);
