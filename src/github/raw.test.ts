import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyBucket } from "../../test/r2";
import {
  archiveContributions,
  archiveSearchPage,
  contributionsKey,
  searchKey,
  writeOnce,
} from "./raw";

const FETCHED_AT = "2026-09-09T12:00:00.000Z";

beforeEach(() => emptyBucket(env.RAW));

describe("keys", () => {
  it("keys a search page by kind, window, fetch, and page", () => {
    expect(searchKey("pr-authored", "2026-08", FETCHED_AT, 1)).toBe(
      `raw/search/pr-authored/2026-08/${FETCHED_AT}/0001.json`,
    );
  });

  it("keys each event kind under its own prefix", () => {
    expect(searchKey("pr-reviewed", "2026-08", FETCHED_AT, 1)).toContain("raw/search/pr-reviewed/");
    expect(searchKey("issue", "2026-08", FETCHED_AT, 1)).toContain("raw/search/issue/");
  });

  it("pads page numbers so a listing stays in read order", () => {
    const keys = [1, 2, 10].map((page) => searchKey("issue", "2026-08", FETCHED_AT, page));

    expect(keys.toSorted()).toEqual(keys);
  });

  it("keys a contributions window by year and fetch", () => {
    expect(contributionsKey("2025", FETCHED_AT)).toBe(`raw/contributions/2025/${FETCHED_AT}.json`);
  });
});

describe("writeOnce", () => {
  it("writes the body as received", async () => {
    const body = '{"data":{"search":{}}}';

    await writeOnce(env.RAW, "raw/search/issue/2026-08/fetch/0001.json", body);

    const stored = await env.RAW.get("raw/search/issue/2026-08/fetch/0001.json");
    await expect(stored?.text()).resolves.toBe(body);
  });

  it("reports the write", async () => {
    await expect(writeOnce(env.RAW, "raw/contributions/2025/fetch.json", "{}")).resolves.toBe(true);
  });

  it("refuses to overwrite an existing key", async () => {
    await writeOnce(env.RAW, "raw/contributions/2025/fetch.json", '{"first":true}');

    await expect(
      writeOnce(env.RAW, "raw/contributions/2025/fetch.json", '{"second":true}'),
    ).resolves.toBe(false);

    const stored = await env.RAW.get("raw/contributions/2025/fetch.json");
    await expect(stored?.text()).resolves.toBe('{"first":true}');
  });
});

describe("archiving", () => {
  it("writes a search page under its key", async () => {
    const written = await archiveSearchPage(env.RAW, {
      kind: "pr-authored",
      window: "2026-08",
      fetchedAt: FETCHED_AT,
      page: 2,
      body: '{"page":2}',
    });

    expect(written).toBe(true);
    const stored = await env.RAW.get(searchKey("pr-authored", "2026-08", FETCHED_AT, 2));
    await expect(stored?.text()).resolves.toBe('{"page":2}');
  });

  it("writes a contributions window under its key", async () => {
    await archiveContributions(env.RAW, {
      window: "2025",
      fetchedAt: FETCHED_AT,
      body: '{"year":2025}',
    });

    const stored = await env.RAW.get(contributionsKey("2025", FETCHED_AT));
    await expect(stored?.text()).resolves.toBe('{"year":2025}');
  });

  it("lands a re-run under a new fetch rather than over the last one", async () => {
    const earlier = "2026-09-09T11:00:00.000Z";
    await archiveSearchPage(env.RAW, {
      kind: "issue",
      window: "2026-08",
      fetchedAt: earlier,
      page: 1,
      body: '{"fetch":"earlier"}',
    });

    await archiveSearchPage(env.RAW, {
      kind: "issue",
      window: "2026-08",
      fetchedAt: FETCHED_AT,
      page: 1,
      body: '{"fetch":"later"}',
    });

    const listed = await env.RAW.list({ prefix: "raw/search/issue/2026-08/" });
    expect(listed.objects.map((object) => object.key)).toEqual([
      searchKey("issue", "2026-08", earlier, 1),
      searchKey("issue", "2026-08", FETCHED_AT, 1),
    ]);
  });
});
