import { unhandled } from "../unhandled";
import type { Episode, HistoryItem, Movie, RatingItem, Season, Show } from "./schema";
import {
  type Play,
  type Rating,
  type Title,
  upsertPlays,
  upsertRatings,
  upsertTitles,
} from "./store";

export interface TraktRowsChanged {
  titles: number;
  plays: number;
  ratings: number;
}

export const UNCHANGED: TraktRowsChanged = { titles: 0, plays: 0, ratings: 0 };

export function addRows(rows: TraktRowsChanged, changed: TraktRowsChanged): TraktRowsChanged {
  return {
    titles: rows.titles + changed.titles,
    plays: rows.plays + changed.plays,
    ratings: rows.ratings + changed.ratings,
  };
}

const EMPTY_TITLE = {
  slug: null,
  title: null,
  year: null,
  showTraktId: null,
  season: null,
  number: null,
  imdbId: null,
  tmdbId: null,
  tvdbId: null,
  released: null,
  firstAired: null,
  runtime: null,
  genres: null,
  certification: null,
  network: null,
  country: null,
  language: null,
  status: null,
} as const satisfies Partial<Title>;

function genres(value: readonly string[] | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

export function movieTitle(movie: Movie, fetchedAt: string): Title {
  return {
    ...EMPTY_TITLE,
    type: "movie",
    traktId: movie.ids.trakt,
    slug: movie.ids.slug,
    title: movie.title,
    year: movie.year,
    imdbId: movie.ids.imdb,
    tmdbId: movie.ids.tmdb,
    released: movie.released,
    runtime: movie.runtime,
    genres: genres(movie.genres),
    certification: movie.certification,
    country: movie.country,
    language: movie.language,
    status: movie.status,
    fetchedAt,
  };
}

export function showTitle(show: Show, fetchedAt: string): Title {
  return {
    ...EMPTY_TITLE,
    type: "show",
    traktId: show.ids.trakt,
    slug: show.ids.slug,
    title: show.title,
    year: show.year,
    imdbId: show.ids.imdb,
    tmdbId: show.ids.tmdb,
    tvdbId: show.ids.tvdb,
    firstAired: show.first_aired,
    runtime: show.runtime,
    genres: genres(show.genres),
    certification: show.certification,
    network: show.network,
    country: show.country,
    language: show.language,
    status: show.status,
    fetchedAt,
  };
}

function seasonTitle(season: Season, show: Show, fetchedAt: string): Title {
  return {
    ...EMPTY_TITLE,
    type: "season",
    traktId: season.ids.trakt,
    title: season.title,
    showTraktId: show.ids.trakt,
    season: season.number,
    tmdbId: season.ids.tmdb,
    tvdbId: season.ids.tvdb,
    firstAired: season.first_aired,
    fetchedAt,
  };
}

export function episodeTitle(episode: Episode, show: Show, fetchedAt: string): Title {
  return {
    ...EMPTY_TITLE,
    type: "episode",
    traktId: episode.ids.trakt,
    title: episode.title,
    showTraktId: show.ids.trakt,
    season: episode.season,
    number: episode.number,
    imdbId: episode.ids.imdb,
    tmdbId: episode.ids.tmdb,
    tvdbId: episode.ids.tvdb,
    firstAired: episode.first_aired,
    runtime: episode.runtime,
    fetchedAt,
  };
}

export interface HistoryRows {
  titles: Title[];
  plays: Play[];
}

export function historyRows(items: readonly HistoryItem[], fetchedAt: string): HistoryRows {
  const titles = new TitleSet();
  const plays = items.map((item): Play => {
    const play = { id: item.id, watchedAt: item.watched_at, action: item.action };
    if (item.type === "movie") {
      titles.add(movieTitle(item.movie, fetchedAt));
      return { ...play, type: "movie", traktId: item.movie.ids.trakt, showTraktId: null };
    }
    titles.add(showTitle(item.show, fetchedAt));
    titles.add(episodeTitle(item.episode, item.show, fetchedAt));
    return {
      ...play,
      type: "episode",
      traktId: item.episode.ids.trakt,
      showTraktId: item.show.ids.trakt,
    };
  });
  return { titles: titles.rows(), plays };
}

export interface RatingRows {
  titles: Title[];
  ratings: Rating[];
}

export function ratingRows(items: readonly RatingItem[], fetchedAt: string): RatingRows {
  const titles = new TitleSet();
  const ratings = items.map((item): Rating => {
    const rating = { rating: item.rating, ratedAt: item.rated_at };
    switch (item.type) {
      case "movie":
        titles.add(movieTitle(item.movie, fetchedAt));
        return { ...rating, type: "movie", traktId: item.movie.ids.trakt, showTraktId: null };
      case "show":
        titles.add(showTitle(item.show, fetchedAt));
        return { ...rating, type: "show", traktId: item.show.ids.trakt, showTraktId: null };
      case "season":
        titles.add(showTitle(item.show, fetchedAt));
        titles.add(seasonTitle(item.season, item.show, fetchedAt));
        return {
          ...rating,
          type: "season",
          traktId: item.season.ids.trakt,
          showTraktId: item.show.ids.trakt,
        };
      case "episode":
        titles.add(showTitle(item.show, fetchedAt));
        titles.add(episodeTitle(item.episode, item.show, fetchedAt));
        return {
          ...rating,
          type: "episode",
          traktId: item.episode.ids.trakt,
          showTraktId: item.show.ids.trakt,
        };
      default:
        throw unhandled(item);
    }
  });
  return { titles: titles.rows(), ratings };
}

// A page names a show once per episode played, so each title is written once.
class TitleSet {
  readonly #titles = new Map<string, Title>();

  add(title: Title): void {
    this.#titles.set(`${title.type}:${title.traktId}`, title);
  }

  rows(): Title[] {
    return [...this.#titles.values()];
  }
}

// Titles land first, since plays and ratings reference them.
export async function normalizeHistory(
  db: D1Database,
  items: readonly HistoryItem[],
  fetchedAt: string,
): Promise<TraktRowsChanged> {
  const rows = historyRows(items, fetchedAt);
  const titles = await upsertTitles(db, rows.titles);
  return { ...UNCHANGED, titles, plays: await upsertPlays(db, rows.plays) };
}

export async function normalizeRatings(
  db: D1Database,
  items: readonly RatingItem[],
  fetchedAt: string,
): Promise<TraktRowsChanged> {
  const rows = ratingRows(items, fetchedAt);
  const titles = await upsertTitles(db, rows.titles);
  return { ...UNCHANGED, titles, ratings: await upsertRatings(db, rows.ratings) };
}
