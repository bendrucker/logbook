import { stubFetch } from "./fetch-stub";

// Shapes follow Trakt's reference for `extended=full`, trimmed to the fields
// normalization reads plus a few it ignores, so a schema that stopped tolerating
// extra fields would fail here.

export function movie(trakt: number, overrides: Record<string, unknown> = {}) {
  return {
    title: "Batman Begins",
    year: 2005,
    ids: { trakt, slug: "batman-begins-2005", imdb: "tt0372784", tmdb: 272 },
    tagline: "Evil fears the knight.",
    released: "2005-06-15",
    runtime: 140,
    genres: ["action", "crime"],
    certification: "PG-13",
    country: "us",
    language: "en",
    status: "released",
    ...overrides,
  };
}

export function show(trakt: number, overrides: Record<string, unknown> = {}) {
  return {
    title: "Breaking Bad",
    year: 2008,
    ids: { trakt, slug: "breaking-bad", tvdb: 81189, imdb: "tt0903747", tmdb: 1396 },
    first_aired: "2008-01-21T02:00:00.000Z",
    runtime: 45,
    genres: ["drama"],
    certification: "TV-MA",
    network: "AMC",
    country: "us",
    language: "en",
    status: "ended",
    ...overrides,
  };
}

export function episode(trakt: number, overrides: Record<string, unknown> = {}) {
  return {
    season: 1,
    number: 1,
    title: "Pilot",
    ids: { trakt, tvdb: 349232, imdb: "tt0959621", tmdb: 62085 },
    first_aired: "2008-01-21T02:00:00.000Z",
    runtime: 58,
    episode_type: "series_premiere",
    ...overrides,
  };
}

export function season(trakt: number, overrides: Record<string, unknown> = {}) {
  return { number: 1, ids: { trakt, tvdb: 30272, tmdb: 3572 }, ...overrides };
}

export function moviePlay(id: number, watchedAt: string, movieId = 1) {
  return { id, watched_at: watchedAt, action: "watch", type: "movie", movie: movie(movieId) };
}

export function episodePlay(id: number, watchedAt: string, episodeId = 16, showId = 1) {
  return {
    id,
    watched_at: watchedAt,
    action: "scrobble",
    type: "episode",
    episode: episode(episodeId),
    show: show(showId),
  };
}

export function movieRating(rating: number, ratedAt: string, movieId = 1) {
  return { rated_at: ratedAt, rating, type: "movie", movie: movie(movieId) };
}

export function seasonRating(rating: number, ratedAt: string, seasonId = 3, showId = 1) {
  return {
    rated_at: ratedAt,
    rating,
    type: "season",
    season: season(seasonId),
    show: show(showId),
  };
}

export interface PageOf {
  page: number;
  pageCount: number;
  itemCount?: number;
  limit?: number;
}

// A page with Trakt's pagination headers, or none when `paging` is null, as an
// endpoint that answers unpaginated sends. Trakt reports an empty result as
// zero pages.
export function traktResponse(
  items: unknown[],
  paging: PageOf | null = { page: 1, pageCount: items.length === 0 ? 0 : 1 },
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (paging !== null) {
    headers.set("X-Pagination-Page", String(paging.page));
    headers.set("X-Pagination-Limit", String(paging.limit ?? 250));
    headers.set("X-Pagination-Page-Count", String(paging.pageCount));
    headers.set("X-Pagination-Item-Count", String(paging.itemCount ?? items.length));
  }
  return new Response(JSON.stringify(items), { status: 200, headers });
}

export function rateLimited(retryAfter: number) {
  return new Response('{"error":"rate limited"}', {
    status: 429,
    headers: { "Retry-After": String(retryAfter) },
  });
}

export function stubTrakt(replies: readonly (() => Response)[]) {
  const queue = [...replies];
  const { fetch, requests } = stubFetch(() => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("the sync asked for more pages than the test staged");
    }
    return next();
  });
  const urls = () => requests.map((request) => new URL(request.url));
  return { fetch, requests, urls };
}
