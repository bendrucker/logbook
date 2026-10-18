import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LAKE_MAX_AGE_SECONDS, LAKE_PREFIXES } from "./lake";
import { probeLake, recordProbes } from "./probes";

beforeEach(async () => {
  const listed = await env.LAKE.list();
  await env.LAKE.delete(listed.objects.map((object) => object.key));
  await env.DB.prepare("DELETE FROM probes").run();
});

describe("probeLake", () => {
  it("probes every table under the published prefixes and nothing else", async () => {
    await env.LAKE.put("github/v1/pull_requests/part-0.parquet", "x");
    await env.LAKE.put("lake/v1/activities/2026/part-0.parquet", "x");

    const probes = await probeLake(env.LAKE, new Date());

    expect(probes.map((probe) => probe.target)).toEqual([
      "github/v1/pull_requests",
      ...LAKE_PREFIXES.slice(1),
    ]);
    expect(probes[0]).toMatchObject({ probe: "lake.freshness", good: true });
  });

  it("reads a table past the threshold as stale", async () => {
    await env.LAKE.put("trakt/v1/plays/part-0.parquet", "x");
    const later = new Date(Date.now() + (LAKE_MAX_AGE_SECONDS + 60) * 1000);

    const plays = (await probeLake(env.LAKE, later)).find((probe) =>
      probe.target.startsWith("trakt/"),
    );

    expect(plays).toMatchObject({ target: "trakt/v1/plays", good: false });
  });

  it("reads a prefix with no tables as stale", async () => {
    const probes = await probeLake(env.LAKE, new Date());

    expect(probes).toHaveLength(LAKE_PREFIXES.length);
    expect(probes.every((probe) => !probe.good && probe.value === null)).toBe(true);
  });
});

describe("recordProbes", () => {
  it("writes one row per probe", async () => {
    await recordProbes(env.DB, new Date("2026-10-18T12:47:00Z"), [
      { probe: "lake.freshness", target: "github/v1/issues", good: true, value: 60, threshold: 1 },
      { probe: "lake.freshness", target: "music/v1/", good: false, value: null, threshold: 1 },
    ]);

    const { results } = await env.DB.prepare(
      "SELECT probed_at, target, good, value FROM probes ORDER BY id",
    ).all();
    expect(results).toEqual([
      { probed_at: "2026-10-18T12:47:00.000Z", target: "github/v1/issues", good: 1, value: 60 },
      { probed_at: "2026-10-18T12:47:00.000Z", target: "music/v1/", good: 0, value: null },
    ]);
  });
});
