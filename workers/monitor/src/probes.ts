import { LAKE_MAX_AGE_SECONDS, LAKE_PREFIXES, listObjects, tableAges } from "./lake";

export interface Probe {
  probe: string;
  target: string;
  good: boolean;
  value: number | null;
  threshold: number;
}

// One probe per table, and one per prefix that holds no table at all, so a
// source whose tables all vanish reads as stale rather than as nothing.
export async function probeLake(bucket: R2Bucket, now: Date): Promise<Probe[]> {
  const listed = await Promise.all(
    LAKE_PREFIXES.map(async (prefix) => ({
      prefix,
      ages: tableAges(await listObjects(bucket, prefix), now),
    })),
  );
  return listed.flatMap(({ prefix, ages }): Probe[] =>
    ages.length === 0
      ? [
          {
            probe: "lake.freshness",
            target: prefix,
            good: false,
            value: null,
            threshold: LAKE_MAX_AGE_SECONDS,
          },
        ]
      : ages.map(({ table, ageSeconds }) => ({
          probe: "lake.freshness",
          target: table,
          good: ageSeconds < LAKE_MAX_AGE_SECONDS,
          value: ageSeconds,
          threshold: LAKE_MAX_AGE_SECONDS,
        })),
  );
}

export async function recordProbes(db: D1Database, probedAt: Date, probes: Probe[]): Promise<void> {
  const insert = db.prepare(
    "INSERT INTO probes (probed_at, probe, target, good, value, threshold)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  );
  const at = probedAt.toISOString();
  await db.batch(
    probes.map((probe) =>
      insert.bind(at, probe.probe, probe.target, probe.good ? 1 : 0, probe.value, probe.threshold),
    ),
  );
}
