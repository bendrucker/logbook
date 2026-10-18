import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { finishBuild, failBuild, startBuild } from "./lake/builds";
import { sampleFreshness } from "./sli";
import { advance } from "./sync/state";

const now = new Date("2026-09-09T18:00:00.000Z");

async function storedSamples(): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    "SELECT sampled_at, kind, watermark, lag_seconds FROM sli_samples ORDER BY kind",
  ).all();
  return results;
}

describe("sampleFreshness", () => {
  it("records each watermark's lag behind now", async () => {
    await advance(env.DB, "issue", "2026-09-09T17:00:00.000Z");
    await advance(env.DB, "trakt-history", "2026-09-09T12:30:00.000Z");

    await sampleFreshness(env.DB, now);

    expect(await storedSamples()).toEqual([
      {
        sampled_at: "2026-09-09T18:00:00.000Z",
        kind: "issue",
        watermark: "2026-09-09T17:00:00.000Z",
        lag_seconds: 3600,
      },
      { sampled_at: "2026-09-09T18:00:00.000Z", kind: "lake", watermark: null, lag_seconds: null },
      {
        sampled_at: "2026-09-09T18:00:00.000Z",
        kind: "trakt-history",
        watermark: "2026-09-09T12:30:00.000Z",
        lag_seconds: 19800,
      },
    ]);
  });

  it("omits kinds without a watermark", async () => {
    const samples = await sampleFreshness(env.DB, now);

    expect(samples.map((sample) => sample.kind)).toEqual(["lake"]);
  });

  it("measures the lake from its newest successful build", async () => {
    const built = await startBuild(env.DB, "2026-09-08T09:30:00.000Z");
    await finishBuild(env.DB, built, { issues: 3 }, "2026-09-08T09:35:00.000Z");
    const failed = await startBuild(env.DB, "2026-09-09T09:30:00.000Z");
    await failBuild(env.DB, failed, "Error: R2 refused", "2026-09-09T09:31:00.000Z");
    await startBuild(env.DB, "2026-09-09T17:59:00.000Z");

    const samples = await sampleFreshness(env.DB, now);

    expect(samples).toEqual([
      { kind: "lake", watermark: "2026-09-08T09:35:00.000Z", lagSeconds: 30_300 + 86_400 },
    ]);
  });
});
