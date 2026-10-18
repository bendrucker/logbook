import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { evaluateAlerts } from "./alerts";
import { recordMetrics } from "./metrics";
import { rules } from "./rules";

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM metrics"), env.DB.prepare("DELETE FROM alerts")]);
});

const stale = rules.parse([
  { name: "lake-stale", metric: "lake.age_seconds", above: 100, for: 2, route: "log" },
]);

async function run(value: number, at: string): Promise<string[]> {
  const now = new Date(at);
  const metrics = [{ metric: "lake.age_seconds", target: "github/v1/issues", value }];
  await recordMetrics(env.DB, now, metrics);
  return (await evaluateAlerts(env.DB, stale, metrics, now)).map((change) => change.change);
}

describe("evaluateAlerts", () => {
  it("opens once `for` samples breach and resolves on the next that doesn't", async () => {
    expect(await run(200, "2026-10-18T10:47:00Z")).toEqual([]);
    expect(await run(200, "2026-10-18T11:47:00Z")).toEqual(["opened"]);
    expect(await run(200, "2026-10-18T12:47:00Z")).toEqual([]);
    expect(await run(50, "2026-10-18T13:47:00Z")).toEqual(["resolved"]);

    const { results } = await env.DB.prepare(
      "SELECT rule, target, route, opened_at, resolved_at FROM alerts",
    ).all();
    expect(results).toEqual([
      {
        rule: "lake-stale",
        target: "github/v1/issues",
        route: "log",
        opened_at: "2026-10-18T11:47:00.000Z",
        resolved_at: "2026-10-18T13:47:00.000Z",
      },
    ]);
  });

  it("ignores one breach between clean samples", async () => {
    expect(await run(50, "2026-10-18T10:47:00Z")).toEqual([]);
    expect(await run(200, "2026-10-18T11:47:00Z")).toEqual([]);
    expect(await run(50, "2026-10-18T12:47:00Z")).toEqual([]);
  });

  it("opens again for a new incident", async () => {
    await run(200, "2026-10-18T10:47:00Z");
    await run(200, "2026-10-18T11:47:00Z");
    await run(50, "2026-10-18T12:47:00Z");
    await run(200, "2026-10-18T13:47:00Z");

    expect(await run(200, "2026-10-18T14:47:00Z")).toEqual(["opened"]);
  });
});
