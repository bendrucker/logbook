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
  route,
  setSecrets,
  stubInstapaper,
} from "../../test/instapaper-fixtures";
import { emptyBucket } from "../../test/r2";
import { enqueue } from "../sync/frontier";
import { advance, readWatermark } from "../sync/state";
import { syncInstapaper } from "./incremental";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const EARLIER = "2026-09-10T11:00:00.000Z";

beforeEach(async () => {
  setSecrets(env);
  await emptyBucket(env.RAW);
});

afterEach(() => {
  clearSecrets(env);
});

async function units(kind: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(
    "SELECT window, status FROM crawl_units WHERE kind = ?1 ORDER BY window",
  )
    .bind(kind)
    .all();
  return results;
}

describe("syncInstapaper", () => {
  it("does nothing while a secret is missing", async () => {
    clearSecrets(env);
    const stub = stubInstapaper(() => json([]));

    await syncInstapaper(env, { fetch: stub.fetch, now: NOW });

    expect(stub.calls).toHaveLength(0);
  });

  it("leaves the first read to a backfill, still draining highlights", async () => {
    await enqueue(env.DB, "instapaper-highlights", ["5"], EARLIER);
    const stub = stubInstapaper(() => json([highlight(1, 5)]));

    await syncInstapaper(env, { fetch: stub.fetch, now: NOW });

    expect(stub.calls.map(route)).toEqual(["/api/1.1/bookmarks/5/highlights"]);
    expect(await readWatermark(env.DB, "instapaper-bookmarks")).toBeNull();
  });

  it("reads each listing's delta, then the highlights of what changed", async () => {
    await advance(env.DB, "instapaper-bookmarks", EARLIER);
    const stub = stubInstapaper((call) => {
      switch (route(call)) {
        case "/api/1/folders/list":
          return json([folder(7, "Essays")]);
        case "list:unread":
          return listing([bookmark(1)]);
        case "list:7":
          return listing([bookmark(2)]);
        case "list:starred":
          return listing([bookmark(1, { starred: "1" })]);
        default:
          return call.path.endsWith("/highlights") ? json([]) : listing([]);
      }
    });

    await syncInstapaper(env, { fetch: stub.fetch, now: NOW });

    expect(stub.calls.map(route)).toEqual([
      "/api/1/folders/list",
      "list:unread",
      "list:archive",
      "list:7",
      "list:starred",
      "/api/1.1/bookmarks/1/highlights",
      "/api/1.1/bookmarks/2/highlights",
    ]);
    expect((await readWatermark(env.DB, "instapaper-bookmarks"))?.window).toBe(NOW.toISOString());
    expect(await units("instapaper-highlights")).toEqual([
      { window: "1", status: "done" },
      { window: "2", status: "done" },
    ]);
  });

  it("stops at the first limit and leaves the watermark where it was", async () => {
    await advance(env.DB, "instapaper-bookmarks", EARLIER);
    const stub = stubInstapaper((call) => {
      switch (route(call)) {
        case "/api/1/folders/list":
          return json([]);
        case "list:unread":
          return listing([bookmark(1)]);
        default:
          return apiError(1040, "Rate-limit exceeded");
      }
    });

    await syncInstapaper(env, { fetch: stub.fetch, now: NOW });

    expect(stub.calls.map(route)).toEqual(["/api/1/folders/list", "list:unread", "list:archive"]);
    expect((await readWatermark(env.DB, "instapaper-bookmarks"))?.window).toBe(EARLIER);
    // What landed before the stop still has its highlights read next time.
    expect(await units("instapaper-highlights")).toEqual([{ window: "1", status: "pending" }]);
  });
});
