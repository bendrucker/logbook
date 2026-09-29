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
  it("does nothing while the token is missing", async () => {
    clearSecrets(env);
    const stub = stubInstapaper(() => folders());

    await syncInstapaper(env, { fetch: stub.fetch, now: NOW });

    expect(stub.calls).toHaveLength(0);
  });

  it("leaves the first read to a backfill, still draining highlights", async () => {
    await enqueue(env.DB, "instapaper-highlights", ["5"], EARLIER);
    const stub = stubInstapaper(() => highlights(highlight(1, 5)));

    await syncInstapaper(env, { fetch: stub.fetch, now: NOW });

    expect(stub.calls.map(route)).toEqual(["highlights:5"]);
    expect(await readWatermark(env.DB, "instapaper-bookmarks")).toBeNull();
  });

  it("reads changes from just behind the watermark, then the highlights of what changed", async () => {
    await advance(env.DB, "instapaper-bookmarks", EARLIER);
    const stub = stubInstapaper((call) => {
      switch (route(call)) {
        case "/api/2/folders":
          return folders(folder(7, "Essays"));
        case "/api/2/bookmarks":
          return changes([bookmark(1), bookmark(2, { folder_id: 7 })]);
        default:
          return highlights();
      }
    });

    await syncInstapaper(env, { fetch: stub.fetch, now: NOW });

    expect(stub.calls.map(route)).toEqual([
      "/api/2/folders",
      "/api/2/bookmarks",
      "highlights:1",
      "highlights:2",
    ]);
    // Five minutes before 11:00.
    expect(stub.calls[1]?.query.since).toBe(String(Date.parse(EARLIER) / 1000 - 300));
    expect((await readWatermark(env.DB, "instapaper-bookmarks"))?.window).toBe(NOW.toISOString());
    expect(await units("instapaper-highlights")).toEqual([
      { window: "1", status: "done" },
      { window: "2", status: "done" },
    ]);
  });

  it("stops at a limit and leaves the watermark where it was", async () => {
    await advance(env.DB, "instapaper-bookmarks", EARLIER);
    const full = Array.from({ length: 500 }, (_, index) => bookmark(index + 1));
    const stub = stubInstapaper((call) => {
      if (route(call) === "/api/2/folders") {
        return folders();
      }
      return call.query.offset === "0" ? changes(full) : apiError(429, "Rate limit exceeded");
    });

    await syncInstapaper(env, { fetch: stub.fetch, now: NOW });

    expect(stub.calls.map(route)).toEqual([
      "/api/2/folders",
      "/api/2/bookmarks",
      "/api/2/bookmarks",
    ]);
    expect((await readWatermark(env.DB, "instapaper-bookmarks"))?.window).toBe(EARLIER);
    // What landed before the stop still has its highlights read next time.
    expect(await units("instapaper-highlights")).toHaveLength(500);
  });
});
