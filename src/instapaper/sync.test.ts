import { env } from "cloudflare:test";
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
import { readRow } from "../../test/tables";
import { RequestCap } from "../request-cap";
import { MissingSecretError } from "../sync/run";
import { readMetadata } from "./raw";
import {
  FULL_READ_PAGES,
  instapaperCredentials,
  syncFolders,
  syncHighlights,
  syncListing,
} from "./sync";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const SEEDED = new Date("2026-09-10T11:00:00.000Z");

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

interface StoredBookmark {
  bookmark_id: number;
  folder: string | null;
  folder_id: number | null;
  starred: number;
  unlisted_at: string | null;
  deleted_at: string | null;
}

function stored(id: number): Promise<StoredBookmark | null> {
  return readRow<StoredBookmark>(
    env.DB,
    "SELECT bookmark_id, folder, folder_id, starred, unlisted_at, deleted_at FROM instapaper_bookmarks WHERE bookmark_id = ?",
    id,
  );
}

async function seed(listed: Parameters<typeof syncListing>[1], ...ids: number[]): Promise<void> {
  const stub = stubInstapaper(() => listing(ids.map((id) => bookmark(id))));
  await syncListing(env, listed, "full", { ...options(stub.fetch), now: SEEDED });
}

describe("instapaperCredentials", () => {
  it("names the first secret that is missing", () => {
    env.INSTAPAPER_ACCESS_SECRET = "";

    expect(() => instapaperCredentials(env)).toThrow(MissingSecretError);
    expect(() => instapaperCredentials(env)).toThrow("INSTAPAPER_ACCESS_SECRET");
  });
});

describe("syncFolders", () => {
  it("archives the list and replaces the folders D1 holds", async () => {
    await env.DB.prepare(
      "INSERT INTO instapaper_folders (folder_id, title, fetched_at) VALUES (9, 'Gone', ?)",
    )
      .bind(NOW.toISOString())
      .run();
    const stub = stubInstapaper(() => json([folder(1, "Essays"), folder(2, "Recipes")]));

    const run = await syncFolders(env, options(stub.fetch));

    expect(run).toMatchObject({ pages: 1, error: null });
    expect(stub.calls.map((call) => call.path)).toEqual(["/api/1/folders/list"]);
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

describe("syncListing", () => {
  it("sends what D1 holds as have, with hashes and never progress", async () => {
    await seed({ folder: "unread" }, 1, 2);
    const stub = stubInstapaper(() => listing([]));

    await syncListing(env, { folder: "unread" }, "delta", options(stub.fetch));

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.form).toEqual({
      folder_id: "unread",
      limit: "500",
      have: "1:hash-1,2:hash-2",
    });
  });

  it("archives the page with how it asked, then lands its bookmarks and highlights", async () => {
    const stub = stubInstapaper(() =>
      listing(
        [
          bookmark(1, {
            description: "why I saved it",
            starred: "1",
            progress: 0.5,
            progress_timestamp: 1_788_300_000,
            tags: [{ id: 3, name: "longform" }],
          }),
        ],
        { highlights: [highlight(10, 1, { note: "a note" })] },
      ),
    );

    const run = await syncListing(env, { folder: "archive" }, "delta", options(stub.fetch));

    expect(run).toMatchObject({ pages: 1, error: null, bookmarkIds: [1] });
    const key = `raw/instapaper/instapaper-bookmarks/archive/${NOW.toISOString()}/0001.json`;
    expect(await archivedKeys()).toEqual([key]);
    const head = await env.RAW.head(key);
    expect(readMetadata(head?.customMetadata)).toEqual({
      status: 200,
      failure: null,
      listing: { mode: "delta", have: 0 },
    });
    expect(
      await readRow(
        env.DB,
        "SELECT description, saved_at, starred, folder, progress, progress_at, tags FROM instapaper_bookmarks",
      ),
    ).toEqual({
      description: "why I saved it",
      saved_at: "2026-09-01T00:00:01.000Z",
      starred: 1,
      folder: "archive",
      progress: 0.5,
      progress_at: "2026-09-01T22:00:00.000Z",
      tags: '["longform"]',
    });
    expect(
      await readRow(env.DB, "SELECT highlight_id, bookmark_id, note FROM instapaper_highlights"),
    ).toEqual({ highlight_id: 10, bookmark_id: 1, note: "a note" });
  });

  it("marks what a delta's delete_ids name as unlisted, only where D1 still places it", async () => {
    await seed({ folder: "unread" }, 1, 2);
    // 2 has since moved to the archive, and the archive listing saw it first.
    await seed({ folder: "archive" }, 2);
    const stub = stubInstapaper(() => listing([], { deleteIds: [1, 2] }));

    await syncListing(env, { folder: "unread" }, "delta", options(stub.fetch));

    expect(await stored(1)).toMatchObject({ folder: "unread", unlisted_at: NOW.toISOString() });
    expect(await stored(2)).toMatchObject({ folder: "archive", unlisted_at: null });
  });

  it("clears unlisted when a folder listing returns the bookmark again", async () => {
    await seed({ folder: "unread" }, 1);
    const stub = stubInstapaper(() => listing([], { deleteIds: [1] }));
    await syncListing(env, { folder: "unread" }, "delta", options(stub.fetch));

    await seed({ folder: "folder", folderId: 7 }, 1);

    expect(await stored(1)).toMatchObject({ folder: "folder", folder_id: 7, unlisted_at: null });
  });

  it("leaves the folder alone for the starred listing, and unstars what it drops", async () => {
    await seed({ folder: "unread" }, 2);
    const starred = stubInstapaper(() =>
      listing([bookmark(1, { starred: "1" }), bookmark(2, { starred: "1" })]),
    );
    await syncListing(env, { folder: "starred" }, "delta", {
      ...options(starred.fetch),
      now: SEEDED,
    });
    expect(await stored(1)).toMatchObject({ folder: null, starred: 1 });
    expect(await stored(2)).toMatchObject({ folder: "unread", starred: 1 });

    const dropped = stubInstapaper(() => listing([], { deleteIds: [2] }));
    await syncListing(env, { folder: "starred" }, "delta", options(dropped.fetch));

    expect(dropped.calls[0]?.form["have"]).toBe("1:hash-1,2:hash-2");
    expect(await stored(2)).toMatchObject({ folder: "unread", starred: 0, unlisted_at: null });
  });

  it("reads delete_ids as nothing on a full read", async () => {
    await seed({ folder: "unread" }, 1);
    const stub = stubInstapaper(() => listing([bookmark(2)], { deleteIds: [1] }));

    await syncListing(env, { folder: "unread" }, "full", options(stub.fetch));

    expect(stub.calls[0]?.form["have"]).toBe("");
    expect(await stored(1)).toMatchObject({ unlisted_at: null });
  });

  it("ends a full read on a short page", async () => {
    const stub = stubInstapaper(() => listing([bookmark(1)]));

    const run = await syncListing(env, { folder: "unread" }, "full", options(stub.fetch));

    expect(run).toMatchObject({ pages: 1, truncated: false });
    expect(stub.calls).toHaveLength(1);
  });

  it("marks a full read truncated when have does not page past a full page", async () => {
    const full = Array.from({ length: 500 }, (_, index) => bookmark(index + 1));
    const stub = stubInstapaper((call) => (call.form["have"] === "" ? listing(full) : listing([])));

    const run = await syncListing(env, { folder: "archive" }, "full", options(stub.fetch));

    expect(run).toMatchObject({ pages: 2, truncated: true, error: null });
    expect(stub.calls[1]?.form["have"]?.split(",")).toHaveLength(500);
    const second = await env.RAW.head(
      `raw/instapaper/instapaper-bookmarks/archive/${NOW.toISOString()}/0002.json`,
    );
    expect(readMetadata(second?.customMetadata).listing).toEqual({ mode: "full", have: 500 });
  });

  it("pages a full read while have pages, up to its bound", async () => {
    let next = 1;
    const stub = stubInstapaper(() => {
      const page = Array.from({ length: 500 }, () => bookmark(next++));
      return listing(page);
    });

    const run = await syncListing(env, { folder: "archive" }, "full", options(stub.fetch, 100));

    expect(run).toMatchObject({ pages: FULL_READ_PAGES, truncated: true, error: null });
  }, 30_000);

  it("reads a folder deleted since the folder list as empty", async () => {
    const stub = stubInstapaper(() => apiError(1242, "Invalid or missing folder_id"));

    const run = await syncListing(
      env,
      { folder: "folder", folderId: 9 },
      "full",
      options(stub.fetch),
    );

    expect(run).toMatchObject({ pages: 1, error: null, truncated: false });
    expect(await archivedKeys()).toEqual([
      `raw/instapaper/instapaper-bookmarks/folder-9/${NOW.toISOString()}/0001.json`,
    ]);
  });

  it("archives the failure that stopped it and reports when to resume", async () => {
    const stub = stubInstapaper(() =>
      apiError(1040, "Rate-limit exceeded", { headers: { "Retry-After": "60" } }),
    );

    const run = await syncListing(env, { folder: "unread" }, "delta", options(stub.fetch));

    expect(run.error).toMatch(/^InstapaperRateLimited/);
    expect(run.resumeAt).toBe("2026-09-10T12:01:00.000Z");
    const key = `raw/instapaper/instapaper-bookmarks/unread/${NOW.toISOString()}/0001.json`;
    expect(readMetadata((await env.RAW.head(key))?.customMetadata)).toMatchObject({
      status: 400,
      failure: "InstapaperRateLimited",
    });
  });

  it("stops on the cap before a request, resuming at once", async () => {
    const stub = stubInstapaper(() => listing([]));

    const run = await syncListing(env, { folder: "unread" }, "delta", options(stub.fetch, 0));

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
    const stub = stubInstapaper(() => json([highlight(10, 1), highlight(11, 1, { note: "" })]));

    const run = await syncHighlights(env, 1, options(stub.fetch));

    expect(run).toMatchObject({ pages: 1, error: null });
    expect(stub.calls.map((call) => call.path)).toEqual(["/api/1.1/bookmarks/1/highlights"]);
    const { results } = await env.DB.prepare(
      "SELECT highlight_id, note FROM instapaper_highlights ORDER BY highlight_id",
    ).all();
    expect(results).toEqual([
      { highlight_id: 10, note: null },
      { highlight_id: 11, note: null },
    ]);
  });

  it("marks a bookmark Instapaper no longer recognizes as deleted", async () => {
    await seed({ folder: "unread" }, 1);
    const stub = stubInstapaper(() => apiError(1241, "Invalid or missing bookmark_id"));

    const run = await syncHighlights(env, 1, options(stub.fetch));

    expect(run).toMatchObject({ pages: 1, error: null });
    expect(await stored(1)).toMatchObject({ deleted_at: NOW.toISOString() });
    expect(await archivedKeys()).toContain(
      `raw/instapaper/instapaper-highlights/1/${NOW.toISOString()}/0001.json`,
    );
  });
});
