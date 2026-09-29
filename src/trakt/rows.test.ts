import { describe, expect, it } from "vitest";
import { episodePlay, movieRating, moviePlay, seasonRating } from "../../test/trakt-fixtures";
import { historyRows, ratingRows } from "./rows";
import { historyPage, ratingsPage } from "./schema";

const FETCHED_AT = "2026-09-10T00:00:00.000Z";

describe("historyRows", () => {
  it("writes one play per history entry and each title once", () => {
    const items = historyPage.parse([
      episodePlay(3, "2026-09-02T20:00:00.000Z", 16),
      episodePlay(2, "2026-09-02T19:00:00.000Z", 17),
      moviePlay(1, "2026-09-01T20:00:00.000Z"),
    ]);

    const rows = historyRows(items, FETCHED_AT);

    expect(rows.plays).toEqual([
      {
        id: 3,
        watchedAt: "2026-09-02T20:00:00.000Z",
        action: "scrobble",
        type: "episode",
        traktId: 16,
        showTraktId: 1,
      },
      {
        id: 2,
        watchedAt: "2026-09-02T19:00:00.000Z",
        action: "scrobble",
        type: "episode",
        traktId: 17,
        showTraktId: 1,
      },
      {
        id: 1,
        watchedAt: "2026-09-01T20:00:00.000Z",
        action: "watch",
        type: "movie",
        traktId: 1,
        showTraktId: null,
      },
    ]);
    expect(rows.titles.map((title) => `${title.type}:${title.traktId}`)).toEqual([
      "show:1",
      "episode:16",
      "episode:17",
      "movie:1",
    ]);
  });

  it("carries the extended fields into the title", () => {
    const items = historyPage.parse([episodePlay(1, "2026-09-02T20:00:00.000Z")]);

    const [show, episode] = historyRows(items, FETCHED_AT).titles;

    expect(show).toMatchObject({
      slug: "breaking-bad",
      title: "Breaking Bad",
      year: 2008,
      tvdbId: 81189,
      network: "AMC",
      genres: '["drama"]',
      firstAired: "2008-01-21T02:00:00.000Z",
      fetchedAt: FETCHED_AT,
    });
    expect(episode).toMatchObject({
      title: "Pilot",
      showTraktId: 1,
      season: 1,
      number: 1,
      imdbId: "tt0959621",
      runtime: 58,
      slug: null,
    });
  });

  it("reads a minimal title as nulls", () => {
    const items = historyPage.parse([
      {
        id: 1,
        watched_at: "2026-09-01T20:00:00.000Z",
        action: "checkin",
        type: "movie",
        movie: { title: "Heat", year: 1995, ids: { trakt: 9, slug: "heat-1995" } },
      },
    ]);

    const [title] = historyRows(items, FETCHED_AT).titles;

    expect(title).toMatchObject({ traktId: 9, imdbId: null, released: null, genres: null });
  });
});

describe("ratingRows", () => {
  it("keys each rating on its title and names the show a season belongs to", () => {
    const items = ratingsPage.parse([
      seasonRating(9, "2026-08-01T00:00:00.000Z", 3, 1),
      movieRating(7, "2026-07-01T00:00:00.000Z", 1),
    ]);

    const rows = ratingRows(items, FETCHED_AT);

    expect(rows.ratings).toEqual([
      {
        type: "season",
        traktId: 3,
        rating: 9,
        ratedAt: "2026-08-01T00:00:00.000Z",
        showTraktId: 1,
      },
      {
        type: "movie",
        traktId: 1,
        rating: 7,
        ratedAt: "2026-07-01T00:00:00.000Z",
        showTraktId: null,
      },
    ]);
    expect(rows.titles.map((title) => `${title.type}:${title.traktId}`)).toEqual([
      "show:1",
      "season:3",
      "movie:1",
    ]);
  });
});
