import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bookmark,
  changes,
  clearSecrets,
  folder,
  folders,
  highlight,
  highlights,
  setSecrets,
  stubInstapaper,
} from "../../test/instapaper-fixtures";
import { emptyBucket } from "../../test/r2";
import { RawValidationError } from "../normalize";
import { RequestCap } from "../request-cap";
import { replayInstapaper } from "./replay";
import { EVERYTHING, syncChanges, syncFolders, syncHighlights } from "./sync";

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
      at(1, 0, () => folders(folder(7, "Essays"), folder(8, "Old"))),
    );
    await syncChanges(
      env,
      EVERYTHING,
      at(1, 1, () => changes([bookmark(1), bookmark(2), bookmark(3, { liked: true })])),
    );
    await syncHighlights(
      env,
      1,
      at(2, 0, () => highlights(highlight(10, 1), highlight(11, 1))),
    );
    await syncFolders(
      env,
      at(3, 0, () => folders(folder(7, "Essays"))),
    );
    // 1 moved to Essays, 2 was deleted, and 3 was unliked and archived.
    await syncChanges(
      env,
      new Date(Date.UTC(2026, 8, 10, 1)),
      at(3, 1, () =>
        changes([bookmark(1, { folder_id: 7 }), bookmark(3, { archived: true })], [2]),
      ),
    );
    await syncHighlights(
      env,
      1,
      at(4, 0, () => highlights(highlight(12, 1))),
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
    expect(replayed.pages).toBe(6);
    expect(synced.instapaper_folders).toHaveLength(1);
    expect(synced.instapaper_highlights).toMatchObject([{ highlight_id: 12 }]);
    expect(synced.instapaper_bookmarks).toMatchObject([
      { bookmark_id: 1, folder_id: 7, deleted_at: null },
      { bookmark_id: 2, deleted_at: "2026-09-10T03:01:00.000Z" },
      { bookmark_id: 3, liked: 0, archived: 1 },
    ]);
  });

  it("names the page that no longer validates", async () => {
    await env.RAW.put(
      "raw/instapaper/instapaper-highlights/1/2026-09-10T01:00:00.000Z/0001.json",
      JSON.stringify({ highlights: [{ id: 1 }] }),
      { customMetadata: { status: "200" } },
    );

    const thrown = await replayInstapaper(env.DB, env.RAW).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RawValidationError);
    expect(thrown).toMatchObject({
      key: "raw/instapaper/instapaper-highlights/1/2026-09-10T01:00:00.000Z/0001.json",
    });
  });
});
