import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiError,
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
import { readRow } from "../../test/tables";
import { RequestCap } from "../request-cap";
import { MissingSecretError } from "../sync/run";
import { readMetadata } from "./raw";
import { instapaperToken, syncChanges, syncFolders, syncHighlights } from "./sync";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const SINCE = new Date("2026-09-10T11:00:00.000Z");

beforeEach(async () => {
  setSecrets(env);
  await emptyBucket(env.RAW);
});

afterEach(() => {
  clearSecrets(env);
});

function options(fetch: typeof globalThis.fetch, cap = 50) {
  return { fetch, now: NOW, requests: new RequestCap(cap) };
}

async function archivedKeys(): Promise<string[]> {
  const listed = await env.RAW.list({ prefix: "raw/instapaper/" });
  return listed.objects.map((object) => object.key);
}

function changesKey(page: number): string {
  return `raw/instapaper/instapaper-bookmarks/changes/${NOW.toISOString()}/${String(page).padStart(4, "0")}.json`;
}

describe("instapaperToken", () => {
  it("names the secret when it is missing", () => {
    env.INSTAPAPER_ACCESS_TOKEN = "";

    expect(() => instapaperToken(env)).toThrow(MissingSecretError);
    expect(() => instapaperToken(env)).toThrow("INSTAPAPER_ACCESS_TOKEN");
  });
});

describe("syncFolders", () => {
  it("archives the list and replaces the folders D1 holds", async () => {
    await env.DB.prepare(
      "INSERT INTO instapaper_folders (folder_id, title, slug, position, public, fetched_at)" +
        " VALUES (9, 'Gone', 'gone', 9, 0, ?)",
    )
      .bind(NOW.toISOString())
      .run();
    const stub = stubInstapaper(() => folders(folder(1, "Essays"), folder(2, "Recipes")));

    const run = await syncFolders(env, options(stub.fetch));

    expect(run).toMatchObject({ pages: 1, error: null });
    expect(stub.calls.map((call) => call.path)).toEqual(["/api/2/folders"]);
    expect(await archivedKeys()).toEqual([
      `raw/instapaper/instapaper-bookmarks/folders/${NOW.toISOString()}/0001.json`,
    ]);
    const { results } = await env.DB.prepare(
      "SELECT folder_id, title, public FROM instapaper_folders ORDER BY folder_id",
    ).all();
    expect(results).toEqual([
      { folder_id: 1, title: "Essays", public: 0 },
      { folder_id: 2, title: "Recipes", public: 0 },
    ]);
  });
});

describe("syncChanges", () => {
  it("archives the page, then lands its bookmarks", async () => {
    const stub = stubInstapaper(() =>
      changes([
        bookmark(1, {
          description: "why I saved it",
          liked: true,
          archived: true,
          folder_id: null,
          author: "",
          progress: { percentage: 0.5, timestamp: 1_788_300_000 },
          tags: [{ id: 3, name: "longform", slug: "longform", count: 1, baton: null }],
        }),
      ]),
    );

    const run = await syncChanges(env, SINCE, options(stub.fetch));

    expect(run).toMatchObject({ pages: 1, error: null, bookmarkIds: [1] });
    expect(stub.calls[0]?.query).toEqual({ since: "1789038000", limit: "500", offset: "0" });
    expect(await archivedKeys()).toEqual([changesKey(1)]);
    expect(readMetadata((await env.RAW.head(changesKey(1)))?.customMetadata)).toEqual({
      status: 200,
      failure: null,
    });
    expect(
      await readRow(
        env.DB,
        "SELECT description, author, saved_at, liked, archived, folder_id, progress, progress_at, tags" +
          " FROM instapaper_bookmarks",
      ),
    ).toEqual({
      description: "why I saved it",
      author: null,
      saved_at: "2026-09-01T00:00:01.000Z",
      liked: 1,
      archived: 1,
      folder_id: null,
      progress: 0.5,
      progress_at: "2026-09-01T22:00:00.000Z",
      tags: '["longform"]',
    });
  });

  it("marks deleted IDs deleted, and clears the mark when a bookmark returns", async () => {
    await syncChanges(env, SINCE, options(stubInstapaper(() => changes([bookmark(1)])).fetch));
    await syncChanges(env, SINCE, options(stubInstapaper(() => changes([], [1, 2])).fetch));

    const deleted = "SELECT deleted_at FROM instapaper_bookmarks WHERE bookmark_id = 1";
    expect(await readRow(env.DB, deleted)).toEqual({ deleted_at: NOW.toISOString() });

    await syncChanges(env, SINCE, options(stubInstapaper(() => changes([bookmark(1)])).fetch));

    expect(await readRow(env.DB, deleted)).toEqual({ deleted_at: null });
  });

  it("advances the offset by bookmarks and deleted IDs until a short page", async () => {
    const full = Array.from({ length: 400 }, (_, index) => bookmark(index + 1));
    const deleted = Array.from({ length: 100 }, (_, index) => 1000 + index);
    const stub = stubInstapaper((call) =>
      call.query.offset === "0" ? changes(full, deleted) : changes([bookmark(600)]),
    );

    const run = await syncChanges(env, SINCE, options(stub.fetch));

    expect(stub.calls.map((call) => call.query.offset)).toEqual(["0", "500"]);
    expect(run).toMatchObject({ pages: 2, error: null });
    expect(run.bookmarkIds).toHaveLength(401);
    expect(await archivedKeys()).toEqual([changesKey(1), changesKey(2)]);
  });

  it("archives the failure that stopped it and reports when to resume", async () => {
    const stub = stubInstapaper(() =>
      apiError(429, "Rate limit exceeded", { headers: { "Retry-After": "60" } }),
    );

    const run = await syncChanges(env, SINCE, options(stub.fetch));

    expect(run.error).toMatch(/^InstapaperRateLimited/);
    expect(run.resumeAt).toBe("2026-09-10T12:01:00.000Z");
    expect(readMetadata((await env.RAW.head(changesKey(1)))?.customMetadata)).toEqual({
      status: 429,
      failure: "InstapaperRateLimited",
    });
  });

  it("stops on the cap before a request, resuming at once", async () => {
    const stub = stubInstapaper(() => changes([]));

    const run = await syncChanges(env, SINCE, options(stub.fetch, 0));

    expect(run.error).toMatch(/^RequestCapReached/);
    expect(run.resumeAt).toBe(NOW.toISOString());
    expect(stub.calls).toHaveLength(0);
  });
});

describe("syncHighlights", () => {
  it("replaces the bookmark's highlights with the list", async () => {
    await env.DB.prepare(
      "INSERT INTO instapaper_highlights (highlight_id, bookmark_id, text, position, created_at) VALUES (99, 1, 'old', 0, ?)",
    )
      .bind(NOW.toISOString())
      .run();
    const stub = stubInstapaper(() =>
      highlights(highlight(10, 1, { note: "a note" }), highlight(11, 1, { note: "" })),
    );

    const run = await syncHighlights(env, 1, options(stub.fetch));

    expect(run).toMatchObject({ pages: 1, error: null });
    expect(stub.calls.map((call) => call.path)).toEqual(["/api/2/bookmarks/1/highlights"]);
    const { results } = await env.DB.prepare(
      "SELECT highlight_id, note FROM instapaper_highlights ORDER BY highlight_id",
    ).all();
    expect(results).toEqual([
      { highlight_id: 10, note: "a note" },
      { highlight_id: 11, note: null },
    ]);
  });
});
