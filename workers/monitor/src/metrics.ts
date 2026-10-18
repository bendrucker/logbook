import { LAKE_PREFIXES, listObjects, tableAges } from "./lake";

export interface Metric {
  metric: string;
  target: string;
  value: number;
}

// `lake.age_seconds` for each table, and `lake.tables` for each prefix, so a
// source whose tables all vanish shows as a count of zero rather than as
// nothing at all.
export async function collectLake(bucket: R2Bucket, now: Date): Promise<Metric[]> {
  const listed = await Promise.all(
    LAKE_PREFIXES.map(async (prefix) => ({
      prefix,
      ages: tableAges(await listObjects(bucket, prefix), now),
    })),
  );
  const metrics: Metric[] = [];
  for (const { prefix, ages } of listed) {
    metrics.push({ metric: "lake.tables", target: prefix, value: ages.length });
    for (const { table, ageSeconds } of ages) {
      metrics.push({ metric: "lake.age_seconds", target: table, value: ageSeconds });
    }
  }
  return metrics;
}

export async function recordMetrics(
  db: D1Database,
  sampledAt: Date,
  metrics: Metric[],
): Promise<void> {
  const insert = db.prepare(
    "INSERT INTO metrics (sampled_at, metric, target, value) VALUES (?1, ?2, ?3, ?4)",
  );
  const at = sampledAt.toISOString();
  await db.batch(
    metrics.map((metric) => insert.bind(at, metric.metric, metric.target, metric.value)),
  );
}

// One point per metric: blob1 is the metric, blob2 the target, double1 the
// value. Indexed by metric, so sampling never thins one metric for another.
export function exportMetrics(dataset: AnalyticsEngineDataset, metrics: Metric[]): void {
  for (const { metric, target, value } of metrics) {
    dataset.writeDataPoint({ indexes: [metric], blobs: [metric, target], doubles: [value] });
  }
}
