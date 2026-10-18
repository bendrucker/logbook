import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LAKE_PREFIXES } from "./lake";
import { collectLake, exportMetrics, recordMetrics } from "./metrics";

beforeEach(async () => {
  const listed = await env.LAKE.list();
  await env.LAKE.delete(listed.objects.map((object) => object.key));
  await env.DB.prepare("DELETE FROM metrics").run();
});

describe("collectLake", () => {
  it("measures every table under the published prefixes and nothing else", async () => {
    await env.LAKE.put("github/v1/pull_requests/part-0.parquet", "x");
    await env.LAKE.put("lake/v1/activities/2026/part-0.parquet", "x");

    const metrics = await collectLake(env.LAKE, new Date());

    expect(metrics.filter((m) => m.metric === "lake.age_seconds").map((m) => m.target)).toEqual([
      "github/v1/pull_requests",
    ]);
    expect(metrics.filter((m) => m.metric === "lake.tables")).toEqual(
      LAKE_PREFIXES.map((prefix) => ({
        metric: "lake.tables",
        target: prefix,
        value: prefix === "github/v1/" ? 1 : 0,
      })),
    );
  });
});

describe("recordMetrics", () => {
  it("writes one row per metric", async () => {
    await recordMetrics(env.DB, new Date("2026-10-18T12:47:00Z"), [
      { metric: "lake.age_seconds", target: "github/v1/issues", value: 60 },
      { metric: "lake.tables", target: "music/v1/", value: 0 },
    ]);

    const { results } = await env.DB.prepare(
      "SELECT sampled_at, metric, target, value FROM metrics ORDER BY id",
    ).all();
    expect(results).toEqual([
      {
        sampled_at: "2026-10-18T12:47:00.000Z",
        metric: "lake.age_seconds",
        target: "github/v1/issues",
        value: 60,
      },
      {
        sampled_at: "2026-10-18T12:47:00.000Z",
        metric: "lake.tables",
        target: "music/v1/",
        value: 0,
      },
    ]);
  });
});

describe("exportMetrics", () => {
  it("writes the metric and target as blobs and the value as a double", () => {
    const points: AnalyticsEngineDataPoint[] = [];
    exportMetrics({ writeDataPoint: (point) => void points.push(point ?? {}) }, [
      { metric: "lake.age_seconds", target: "github/v1/issues", value: 60 },
    ]);

    expect(points).toEqual([
      {
        indexes: ["lake.age_seconds"],
        blobs: ["lake.age_seconds", "github/v1/issues"],
        doubles: [60],
      },
    ]);
  });
});
