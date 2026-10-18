import { tracing } from "cloudflare:workers";
import { SYNC_KINDS } from "./sync/kinds";
import { readWatermarks } from "./sync/state";

export interface SliSample {
  // A sync kind, or `lake` for the nightly build.
  kind: string;
  watermark: string | null;
  lagSeconds: number | null;
}

// One sample per kind with a watermark, plus the lake. Frontier-only kinds
// keep no watermark, so they have no freshness to sample. The lake is sampled
// even before its first successful build, as a null lag, so a lake that has
// never built does not read as one that is fresh.
export async function sampleFreshness(
  db: D1Database,
  now: Date = new Date(),
): Promise<SliSample[]> {
  return tracing.enterSpan("logbook.sample", async (span) => {
    const watermarks = await readWatermarks(db);
    const samples: SliSample[] = [];
    for (const kind of SYNC_KINDS) {
      const watermark = watermarks[kind]?.window ?? null;
      if (watermark !== null) {
        samples.push({ kind, watermark, lagSeconds: lagSeconds(watermark, now) });
      }
    }

    const build = await db
      .prepare(
        "SELECT MAX(finished_at) AS finished_at FROM lake_builds" +
          " WHERE finished_at IS NOT NULL AND error IS NULL",
      )
      .first<{ finished_at: string | null }>();
    const built = build?.finished_at ?? null;
    samples.push({
      kind: "lake",
      watermark: built,
      lagSeconds: built === null ? null : lagSeconds(built, now),
    });

    const sampledAt = now.toISOString();
    const insert = db.prepare(
      "INSERT INTO sli_samples (sampled_at, kind, watermark, lag_seconds) VALUES (?1, ?2, ?3, ?4)",
    );
    await db.batch(
      samples.map((sample) =>
        insert.bind(sampledAt, sample.kind, sample.watermark, sample.lagSeconds),
      ),
    );
    span.setAttributes(
      Object.fromEntries(
        samples.map((sample) => [`logbook.lag_s.${sample.kind}`, sample.lagSeconds ?? undefined]),
      ),
    );
    return samples;
  });
}

function lagSeconds(through: string, now: Date): number | null {
  const at = Date.parse(through);
  return Number.isNaN(at) ? null : Math.floor((now.getTime() - at) / 1000);
}
