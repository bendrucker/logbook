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
import { readRow } from "../../test/tables";
import { RequestCap } from "../request-cap";
import { readWatermark } from "../sync/state";
import { backfillInstapaper } from "./backfill";
import { syncChanges } from "./sync";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const EARLIER = "2026-09-10T11:00:00.000Z";

beforeEach(async () => {
  setSecrets(env);
  await emptyBucket(env.RAW);
});

afterEach(() => {
  clearSecrets(env);
});

async function seed(...ids: number[]): Promise<void> {
  const stub = stubInstapaper(() => changes(ids.map((id) => bookmark(id))));
  await syncChanges(env, new Date(EARLIER), {
    fetch: stub.fetch,
    now: new Date(EARLIER),
    requests: new RequestCap(1),
  });
}

async function units(kind: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(
    "SELECT window, status FROM crawl_units WHERE kind = ?1 ORDER BY window",
  )
    .bind(kind)
    .all();
  return results;
}

describe("backfillInstapaper", () => {
  it("reads the whole account and then hands over to the hourly listing", async () => {
    const stub = stubInstapaper((call) =>
      route(call) === "/api/2/folders"
        ? folders(folder(7, "Essays"))
        : changes([bookmark(1), bookmark(2, { folder_id: 7 })]),
    );

    const result = await backfillInstapaper(env, "instapaper-bookmarks", {
      fetch: stub.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({
      kind: "instapaper-bookmarks",
      windows: ["changes"],
      pages: 1,
      rowsChanged: 2,
      pending: 0,
      irreducible: [],
      error: null,
    });
    expect(stub.calls[1]?.query).toMatchObject({ since: "1", offset: "0" });
    expect(await readWatermark(env.DB, "instapaper-bookmarks")).not.toBeNull();
    // Every bookmark it read has its highlights read next.
    expect(await units("instapaper-highlights")).toEqual([
      { window: "1", status: "pending" },
      { window: "2", status: "pending" },
    ]);
  });

  it("resumes a stopped backfill without advancing the watermark", async () => {
    let limited = true;
    const stub = stubInstapaper((call) => {
      if (route(call) === "/api/2/folders") {
        return folders();
      }
      return limited ? apiError(429, "Rate limit exceeded") : changes([bookmark(1)]);
    });

    const stopped = await backfillInstapaper(env, "instapaper-bookmarks", {
      fetch: stub.fetch,
      now: NOW,
    });
    expect(stopped).toMatchObject({
      pending: 1,
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- vitest types asymmetric matchers as `any`
      error: expect.stringMatching(/^InstapaperRateLimited/),
    });
    expect(stopped.resumeAt).not.toBeNull();
    expect(await readWatermark(env.DB, "instapaper-bookmarks")).toBeNull();

    limited = false;
    const resumed = await backfillInstapaper(env, "instapaper-bookmarks", { fetch: stub.fetch });

    expect(resumed).toMatchObject({ windows: ["changes"], pending: 0, error: null });
    expect(await readWatermark(env.DB, "instapaper-bookmarks")).not.toBeNull();
  });

  it("reads the highlights of every bookmark not known to be deleted", async () => {
    await seed(1, 2, 3);
    await env.DB.prepare("UPDATE instapaper_bookmarks SET deleted_at = ?1 WHERE bookmark_id = 2")
      .bind(EARLIER)
      .run();
    const stub = stubInstapaper((call) =>
      route(call) === "highlights:1" ? highlights(highlight(10, 1)) : highlights(),
    );

    const result = await backfillInstapaper(env, "instapaper-highlights", {
      fetch: stub.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({ windows: ["1", "3"], pending: 0, error: null });
    expect(await readRow(env.DB, "SELECT COUNT(*) AS total FROM instapaper_highlights")).toEqual({
      total: 1,
    });
  });

  it("settles a bookmark whose highlights read fails and reads the rest", async () => {
    await seed(1, 2);
    const stub = stubInstapaper((call) =>
      route(call) === "highlights:1"
        ? new Response("upstream down", { status: 500 })
        : highlights(highlight(20, 2)),
    );

    const result = await backfillInstapaper(env, "instapaper-highlights", {
      fetch: stub.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({
      windows: ["1", "2"],
      pending: 0,
      irreducible: ["1"],
      error: null,
    });
    expect(await readRow(env.DB, "SELECT COUNT(*) AS total FROM instapaper_highlights")).toEqual({
      total: 1,
    });
  });

  it("answers a missing token before anything else", async () => {
    clearSecrets(env);

    await expect(backfillInstapaper(env, "instapaper-bookmarks")).rejects.toThrow(
      "INSTAPAPER_ACCESS_TOKEN",
    );
  });
});
