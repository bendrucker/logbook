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
import { readRow } from "../../test/tables";
import { RequestCap } from "../request-cap";
import { readWatermark } from "../sync/state";
import { backfillInstapaper } from "./backfill";
import { syncListing } from "./sync";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const EARLIER = "2026-09-10T11:00:00.000Z";

beforeEach(async () => {
  setSecrets(env);
  await emptyBucket(env.RAW);
});

afterEach(() => {
  clearSecrets(env);
});

describe("backfillInstapaper", () => {
  it("reads every listing whole and then hands over to the hourly delta", async () => {
    const stub = stubInstapaper((call) => {
      switch (route(call)) {
        case "/api/1/folders/list":
          return json([folder(7, "Essays")]);
        case "list:archive":
          return listing([bookmark(1), bookmark(2)]);
        default:
          return listing([]);
      }
    });

    const result = await backfillInstapaper(env, "instapaper-bookmarks", {
      fetch: stub.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({
      kind: "instapaper-bookmarks",
      windows: ["archive", "folder-7", "starred", "unread"],
      pages: 4,
      rowsChanged: 2,
      pending: 0,
      irreducible: [],
      error: null,
    });
    expect(stub.calls.every((call) => (call.form.have ?? "") === "")).toBe(true);
    expect(await readWatermark(env.DB, "instapaper-bookmarks")).not.toBeNull();
  });

  it("resumes a stopped backfill without advancing the watermark", async () => {
    let limited = true;
    const stub = stubInstapaper((call) => {
      if (route(call) === "/api/1/folders/list") {
        return json([]);
      }
      if (route(call) === "list:starred" && limited) {
        return apiError(1040, "Rate-limit exceeded");
      }
      return listing([]);
    });

    const stopped = await backfillInstapaper(env, "instapaper-bookmarks", {
      fetch: stub.fetch,
      now: NOW,
    });
    expect(stopped).toMatchObject({
      pending: 2,
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- vitest types asymmetric matchers as `any`
      error: expect.stringMatching(/^InstapaperRateLimited/),
    });
    expect(stopped.resumeAt).not.toBeNull();
    expect(await readWatermark(env.DB, "instapaper-bookmarks")).toBeNull();

    limited = false;
    const resumed = await backfillInstapaper(env, "instapaper-bookmarks", { fetch: stub.fetch });

    expect(resumed).toMatchObject({ windows: ["starred", "unread"], pending: 0, error: null });
    expect(await readWatermark(env.DB, "instapaper-bookmarks")).not.toBeNull();
  });

  it("settles a folder past the listing limit as irreducible", async () => {
    const full = Array.from({ length: 500 }, (_, index) => bookmark(index + 1));
    const stub = stubInstapaper((call) => {
      if (route(call) === "/api/1/folders/list") {
        return json([]);
      }
      return route(call) === "list:archive" && call.form.have === "" ? listing(full) : listing([]);
    });

    const result = await backfillInstapaper(env, "instapaper-bookmarks", {
      fetch: stub.fetch,
      now: NOW,
    });

    expect(result).toMatchObject({ pending: 0, irreducible: ["archive"], error: null });
  });

  it("reads the highlights of every bookmark not known to be deleted", async () => {
    const seed = stubInstapaper(() => listing([bookmark(1), bookmark(2), bookmark(3)]));
    await syncListing(env, { folder: "unread" }, "full", {
      fetch: seed.fetch,
      now: new Date(EARLIER),
      requests: new RequestCap(1),
    });
    await env.DB.prepare("UPDATE instapaper_bookmarks SET deleted_at = ?1 WHERE bookmark_id = 2")
      .bind(EARLIER)
      .run();
    const stub = stubInstapaper((call) =>
      json(call.path === "/api/1.1/bookmarks/1/highlights" ? [highlight(10, 1)] : []),
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
    const seed = stubInstapaper(() => listing([bookmark(1), bookmark(2)]));
    await syncListing(env, { folder: "unread" }, "full", {
      fetch: seed.fetch,
      now: new Date(EARLIER),
      requests: new RequestCap(1),
    });
    const stub = stubInstapaper((call) =>
      call.path === "/api/1.1/bookmarks/1/highlights"
        ? new Response("upstream down", { status: 500 })
        : json([highlight(20, 2)]),
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

  it("answers a missing secret before anything else", async () => {
    clearSecrets(env);

    await expect(backfillInstapaper(env, "instapaper-bookmarks")).rejects.toThrow(
      "INSTAPAPER_CONSUMER_KEY",
    );
  });
});
