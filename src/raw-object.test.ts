import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { emptyBucket } from "../test/r2";
import { pageName, pageNumber, writeOnce } from "./raw-object";

beforeEach(() => emptyBucket(env.RAW));

describe("pageNumber", () => {
  it.each<{ name: string; key: string; expected: number | null }>([
    {
      name: "a padded page",
      key: `raw/trakt/trakt-history/2024/fetch/${pageName(12)}`,
      expected: 12,
    },
    { name: "a non-numeric name", key: "raw/contributions/2025/fetch.json", expected: null },
    { name: "another suffix", key: "raw/search/issue/2026-08/fetch/0001.txt", expected: null },
  ])("reads $name", ({ key, expected }) => {
    expect(pageNumber(key)).toBe(expected);
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
