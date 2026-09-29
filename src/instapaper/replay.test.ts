import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiError,
  bookmark,
  clearSecrets,
  folder,
  highlight,
  json,
  listing,
  setSecrets,
  stubInstapaper,
} from "../../test/instapaper-fixtures";
import { emptyBucket } from "../../test/r2";
import { RawValidationError } from "../normalize";
import { RequestCap } from "../request-cap";
import { replayInstapaper } from "./replay";
import { syncFolders, syncHighlights, syncListing } from "./sync";

const TABLES = ["instapaper_bookmarks", "instapaper_highlights", "instapaper_folders"];

beforeEach(async () => {
  setSecrets(env);
  await emptyBucket(env.RAW);
});

afterEach(() => {
  clearSecrets(env);
});

function at(hour: number, minute: number, respond: () => Response) {
  const stub = stubInstapaper(respond);
  return {
    fetch: stub.fetch,
    now: new Date(Date.UTC(2026, 8, 10, hour, minute)),
    requests: new RequestCap(10),
  };
}

async function snapshot(): Promise<Record<string, unknown[]>> {
  const entries = await Promise.all(
    TABLES.map(async (table) => {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
      return [table, results] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function emptyInstapaperTables(): Promise<void> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

describe("replayInstapaper", () => {
  it("rebuilds the tables the syncs left, from the archive alone", async () => {
    await syncFolders(
      env,
      at(1, 0, () => json([folder(7, "Essays"), folder(8, "Old")])),
    );
    await syncListing(
      env,
      { folder: "unread" },
      "full",
      at(1, 1, () => listing([bookmark(1), bookmark(2), bookmark(3, { starred: "1" })])),
    );
    await syncListing(
      env,
      { folder: "starred" },
      "full",
      at(1, 2, () => listing([bookmark(3, { starred: "1" })])),
    );
    await syncHighlights(
      env,
      1,
      at(2, 0, () => json([highlight(10, 1), highlight(11, 1)])),
    );
    await syncFolders(
      env,
      at(3, 0, () => json([folder(7, "Essays")])),
    );
    // 1 moved to Essays, 2 left the window, and 3 was unstarred.
    await syncListing(
      env,
      { folder: "folder", folderId: 7 },
      "delta",
      at(3, 1, () => listing([bookmark(1, { hash: "moved" })], { highlights: [highlight(12, 1)] })),
    );
    await syncListing(
      env,
      { folder: "unread" },
      "delta",
      at(3, 2, () => listing([bookmark(3)], { deleteIds: [1, 2] })),
    );
    await syncListing(
      env,
      { folder: "starred" },
      "delta",
      at(3, 3, () => listing([], { deleteIds: [3] })),
    );
    await syncHighlights(
      env,
      1,
      at(4, 0, () => json([highlight(12, 1)])),
    );
    await syncHighlights(
      env,
      2,
      at(4, 1, () => apiError(1241, "Invalid or missing bookmark_id")),
    );
    // A failed read leaves D1 as it was, and the replay skips it.
    await syncHighlights(
      env,
      3,
      at(5, 0, () => new Response("<html>", { status: 200 })),
    );
    const synced = await snapshot();

    await emptyInstapaperTables();
    const replayed = await replayInstapaper(env.DB, env.RAW);

    expect(await snapshot()).toEqual(synced);
    expect(replayed.pages).toBe(10);
    expect(synced.instapaper_folders).toHaveLength(1);
    expect(synced.instapaper_highlights).toMatchObject([{ highlight_id: 12 }]);
    expect(synced.instapaper_bookmarks).toMatchObject([
      { bookmark_id: 1, folder: "folder", folder_id: 7, unlisted_at: null },
      {
        bookmark_id: 2,
        unlisted_at: "2026-09-10T03:02:00.000Z",
        deleted_at: "2026-09-10T04:01:00.000Z",
      },
      { bookmark_id: 3, folder: "unread", starred: 0 },
    ]);
  });

  it("names the page that no longer validates", async () => {
    await env.RAW.put(
      "raw/instapaper/instapaper-highlights/1/2026-09-10T01:00:00.000Z/0001.json",
      JSON.stringify([{ type: "highlight" }]),
      { customMetadata: { status: "200" } },
    );

    const thrown = await replayInstapaper(env.DB, env.RAW).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RawValidationError);
    expect(thrown).toMatchObject({
      key: "raw/instapaper/instapaper-highlights/1/2026-09-10T01:00:00.000Z/0001.json",
    });
  });
});
