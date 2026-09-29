import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commitDay, issue, pullRequest, review, seedRepository } from "../../test/fixtures";
import { parquetRows, readParquet } from "../../test/parquet";
import { bookmark, folder, highlight } from "../../test/instapaper-fixtures";
import { emptyBucket, readObject } from "../../test/r2";
import { episodePlay, movieRating } from "../../test/trakt-fixtures";
import { applyChanges, applyFolders, applyHighlights } from "../instapaper/rows";
import { changesResponse, foldersResponse, highlightsResponse } from "../instapaper/schema";
import { upsertCommitDays, upsertIssues, upsertPullRequests, upsertReviews } from "../store";
import { normalizeHistory, normalizeRatings } from "../trakt/rows";
import { historyPage, ratingsPage } from "../trakt/schema";
import { buildLake, LAKE_TABLES, tableKey } from "./build";
import { readLatestBuild } from "./builds";
import { commitDays } from "./commit-days";
import { instapaperBookmarks, instapaperFolders, instapaperHighlights } from "./instapaper";
import { issues } from "./issues";
import { pullRequests } from "./pull-requests";
import { repositories } from "./repositories";
import { reviews } from "./reviews";
import { traktPlays, traktRatings, traktTitles } from "./trakt";
import type { LakeTable } from "./table";

const STARTED_AT = "2026-09-10T03:00:00.000Z";

async function seed(): Promise<void> {
  await seedRepository(env.DB);
  await upsertPullRequests(env.DB, [pullRequest()]);
  await upsertReviews(env.DB, [review()]);
  await upsertIssues(env.DB, [issue()]);
  await upsertCommitDays(env.DB, [commitDay()]);
}

async function rowsOf(table: LakeTable): Promise<Record<string, unknown>[]> {
  const buffer = await readObject(env.LAKE, tableKey(table));
  expect(buffer, `${table.name} was not written`).not.toBeNull();

  return readParquet(buffer ?? new ArrayBuffer(0));
}

beforeEach(() => emptyBucket(env.LAKE));

describe("buildLake", () => {
  it("writes every table under its source's prefix in the shared bucket", async () => {
    await seed();

    await buildLake(env, STARTED_AT);

    const listed = await env.LAKE.list();
    expect(listed.objects.map((object) => object.key).toSorted()).toEqual(
      LAKE_TABLES.map(tableKey).toSorted(),
    );
    expect(
      listed.objects.every(
        (object) =>
          object.key.startsWith("github/v1/") ||
          object.key.startsWith("trakt/v1/") ||
          object.key.startsWith("instapaper/v1/"),
      ),
    ).toBe(true);
  });

  it("reports the rows it wrote per table", async () => {
    await seed();

    const built = await buildLake(env, STARTED_AT);

    expect(built.rowCounts).toEqual({
      repositories: 1,
      pull_requests: 1,
      reviews: 1,
      issues: 1,
      commit_days: 1,
      trakt_titles: 0,
      trakt_plays: 0,
      trakt_ratings: 0,
      instapaper_bookmarks: 0,
      instapaper_highlights: 0,
      instapaper_folders: 0,
    });
    expect(built.startedAt).toBe(STARTED_AT);
  });

  it.each<{ name: string; table: LakeTable; expected: Record<string, unknown> }>([
    {
      name: "a repository",
      table: repositories,
      expected: {
        id: "R_repo1",
        owner: "bendrucker",
        name: "logbook",
        description: "System of record for GitHub contribution data",
        url: "https://github.com/bendrucker/logbook",
        stargazer_count: 3,
        primary_language: "TypeScript",
        primary_language_color: "#3178c6",
        created_at: new Date("2026-09-01T00:00:00Z"),
        is_fork: false,
        visibility: "PUBLIC",
        fetched_at: new Date("2026-09-09T00:00:00Z"),
      },
    },
    {
      name: "a pull request",
      table: pullRequests,
      expected: {
        id: "PR_pull1",
        repository_id: "R_repo1",
        number: 2,
        title: "add README and design doc",
        author: "bendrucker",
        created_at: new Date("2026-09-09T16:00:00Z"),
        merged_at: new Date("2026-09-09T16:30:00Z"),
        closed_at: new Date("2026-09-09T16:30:00Z"),
        state: "MERGED",
        additions: 345,
        deletions: 2,
        changed_files: 2,
        comment_count: 0,
        review_count: 1,
        updated_at: new Date("2026-09-09T16:30:00Z"),
      },
    },
    {
      name: "a review",
      table: reviews,
      expected: {
        id: "PRR_review1",
        repository_id: "R_repo1",
        pull_request_number: 2,
        pull_request_author: "octocat",
        state: "APPROVED",
        submitted_at: new Date("2026-09-09T16:20:00Z"),
      },
    },
    {
      name: "an issue",
      table: issues,
      expected: {
        id: "I_issue1",
        repository_id: "R_repo1",
        number: 7,
        title: "publish the code feed",
        author: "bendrucker",
        created_at: new Date("2026-09-09T17:00:00Z"),
        closed_at: null,
        state: "OPEN",
        comment_count: 2,
        updated_at: new Date("2026-09-09T17:00:00Z"),
      },
    },
    {
      name: "a commit day, keyed by the day string",
      table: commitDays,
      expected: { repository_id: "R_repo1", day: "2026-09-09", commit_count: 4 },
    },
  ])("writes $name that reads back as D1 holds it", async ({ table, expected }) => {
    await seed();

    await buildLake(env, STARTED_AT);

    expect(await rowsOf(table)).toEqual([expected]);
  });

  it("writes Instapaper rows that read back as D1 holds them", async () => {
    const fetchedAt = "2026-09-10T00:00:00.000Z";
    await applyFolders(
      env.DB,
      foldersResponse.parse({ folders: [folder(7, "Essays")] }).folders,
      fetchedAt,
    );
    await applyChanges(
      env.DB,
      changesResponse.parse({
        bookmarks: [
          bookmark(3_000_000_001, {
            liked: true,
            folder_id: 7,
            author: "A. Writer",
            pubtime: 1_788_000_000,
            category: 3,
            progress: { percentage: 0.25, timestamp: 1_788_220_900 },
          }),
        ],
      }),
      fetchedAt,
    );
    await applyHighlights(
      env.DB,
      3_000_000_001,
      highlightsResponse.parse({
        highlights: [highlight(9, 3_000_000_001, { note: "why", position: 2 })],
      }).highlights,
    );

    await buildLake(env, STARTED_AT);

    expect(await rowsOf(instapaperBookmarks)).toEqual([
      {
        bookmark_id: 3_000_000_001n,
        url: "https://example.com/3000000001",
        title: "Article 3000000001",
        description: null,
        image: null,
        author: "A. Writer",
        article_published_at: new Date(1_788_000_000 * 1000),
        saved_at: new Date((1_788_220_800 + 3_000_000_001) * 1000),
        liked: true,
        archived: false,
        folder_id: 7n,
        progress: 0.25,
        progress_at: new Date("2026-09-01T00:01:40.000Z"),
        private_source: null,
        category: 3,
        tags: "[]",
        deleted_at: null,
        fetched_at: new Date(fetchedAt),
      },
    ]);
    expect(await rowsOf(instapaperHighlights)).toEqual([
      {
        highlight_id: 9n,
        bookmark_id: 3_000_000_001n,
        text: "Passage 9",
        note: "why",
        position: 2,
        created_at: new Date((1_788_220_800 + 3600 + 9) * 1000),
      },
    ]);
    expect(await rowsOf(instapaperFolders)).toEqual([
      {
        folder_id: 7n,
        title: "Essays",
        slug: "essays",
        position: 7,
        public: false,
        fetched_at: new Date(fetchedAt),
      },
    ]);
  });

  it("writes Trakt rows that read back as D1 holds them", async () => {
    const fetchedAt = "2026-09-10T00:00:00.000Z";
    await normalizeHistory(
      env.DB,
      historyPage.parse([episodePlay(9_007_199_254, "2026-09-02T20:00:00.000Z")]),
      fetchedAt,
    );
    await normalizeRatings(
      env.DB,
      ratingsPage.parse([movieRating(8, "2026-08-01T00:00:00.000Z", 5)]),
      fetchedAt,
    );

    await buildLake(env, STARTED_AT);

    expect(await rowsOf(traktPlays)).toEqual([
      {
        id: 9_007_199_254n,
        watched_at: new Date("2026-09-02T20:00:00.000Z"),
        action: "scrobble",
        type: "episode",
        trakt_id: 16,
        show_trakt_id: 1,
      },
    ]);
    expect(await rowsOf(traktRatings)).toEqual([
      {
        type: "movie",
        trakt_id: 5,
        rating: 8,
        rated_at: new Date("2026-08-01T00:00:00.000Z"),
        show_trakt_id: null,
      },
    ]);
    const titles = await rowsOf(traktTitles);
    expect(titles.map((title) => [title.type, title.trakt_id])).toEqual([
      ["episode", 16],
      ["movie", 5],
      ["show", 1],
    ]);
    expect(titles.find((title) => title.type === "movie")).toMatchObject({
      released: "2005-06-15",
      genres: '["action","crime"]',
      fetched_at: new Date(fetchedAt),
    });
  });

  it.each(LAKE_TABLES.map((table) => ({ name: table.name, table })))(
    "covers every $name column D1 holds",
    async ({ table }) => {
      const stored = await env.DB.prepare(`PRAGMA table_info(${table.name})`).all<{
        name: string;
      }>();

      expect(table.columns.map((column) => column.name)).toEqual(
        stored.results.map((column) => column.name).filter((name) => name !== "published_at"),
      );
    },
  );

  it("rebuilds a table in full rather than appending to it", async () => {
    await seed();
    await buildLake(env, STARTED_AT);

    await env.DB.prepare("DELETE FROM pull_requests").run();
    await buildLake(env, STARTED_AT);

    const buffer = await readObject(env.LAKE, tableKey(pullRequests));
    expect(parquetRows(buffer ?? new ArrayBuffer(0))).toBe(0);
  });

  it("writes a readable empty file for a table with no rows", async () => {
    await buildLake(env, STARTED_AT);

    expect(await rowsOf(issues)).toEqual([]);
  });

  it("records the build with its per-table counts", async () => {
    await seed();

    const built = await buildLake(env, STARTED_AT);

    const stored = await readLatestBuild(env.DB);
    expect(stored?.startedAt).toBe(STARTED_AT);
    expect(stored?.finishedAt).toBe(built.finishedAt);
    expect(stored?.rowCounts).toEqual(built.rowCounts);
    expect(stored?.error).toBeNull();
  });

  it("records what failed and lets the error out", async () => {
    await seedRepository(env.DB);
    // `is_fork` is an integer column, so a value outside 0 and 1 reaches the
    // lake as something no column type accepts.
    await env.DB.prepare("UPDATE repositories SET is_fork = 2").run();

    await expect(buildLake(env, STARTED_AT)).rejects.toThrow("is_fork");

    const stored = await readLatestBuild(env.DB);
    expect(stored?.error).toContain("is_fork");
    expect(stored?.finishedAt).not.toBeNull();
    expect(stored?.rowCounts).toEqual({});
  });

  it("leaves the last complete build in place when a table fails", async () => {
    await seed();
    await buildLake(env, STARTED_AT);

    await env.DB.prepare("UPDATE repositories SET is_fork = 2").run();
    await env.DB.prepare("DELETE FROM pull_requests").run();
    await expect(buildLake(env, STARTED_AT)).rejects.toThrow("is_fork");

    // The failing table is read alongside four that would have succeeded, so a
    // build that writes as it encodes leaves those four a generation ahead.
    expect(await rowsOf(pullRequests)).toHaveLength(1);
  });

  it("leaves a build visible while it is still running", async () => {
    const running = buildLake(env, STARTED_AT);
    const stored = await readLatestBuild(env.DB);

    expect(stored?.startedAt).toBe(STARTED_AT);
    expect(stored?.finishedAt).toBeNull();
    await running;
  });

  it("reports no build before the first one runs", async () => {
    await expect(readLatestBuild(env.DB)).resolves.toBeNull();
  });
});
