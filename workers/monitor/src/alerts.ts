import type { Metric } from "./metrics";
import { breaches, type Route, type Rule } from "./rules";

export interface AlertChange {
  rule: string;
  target: string;
  route: Route;
  change: "opened" | "resolved";
  value: number;
}

// A rule opens on a target once its last `for` samples all breach, and
// resolves on the first that doesn't. Only targets this run measured are
// evaluated, so a target that stops being measured is the business of a rule
// on a count, such as `lake.tables`, rather than of its own stale samples.
export async function evaluateAlerts(
  db: D1Database,
  rules: Rule[],
  metrics: Metric[],
  now: Date,
): Promise<AlertChange[]> {
  const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const { results: open } = await db
    .prepare("SELECT rule, target FROM alerts WHERE resolved_at IS NULL")
    .all<{ rule: string; target: string }>();
  const opened = new Set(open.map(({ rule, target }) => `${rule}\n${target}`));

  const changes: AlertChange[] = [];
  for (const rule of rules) {
    const latest = new Map(
      metrics.filter((m) => m.metric === rule.metric).map((m) => [m.target, m.value]),
    );
    if (latest.size === 0) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one query per rule, a handful per run
    const { results } = await db
      .prepare(
        "SELECT target, value FROM (SELECT target, value, ROW_NUMBER() OVER" +
          " (PARTITION BY target ORDER BY sampled_at DESC, id DESC) AS rn" +
          " FROM metrics WHERE metric = ?1 AND sampled_at >= ?2) WHERE rn <= ?3",
      )
      .bind(rule.metric, since, rule.for)
      .all<{ target: string; value: number }>();
    const recent = new Map<string, number[]>();
    for (const row of results) {
      recent.set(row.target, [...(recent.get(row.target) ?? []), row.value]);
    }

    for (const [target, value] of latest) {
      const samples = recent.get(target) ?? [];
      const isOpen = opened.has(`${rule.name}\n${target}`);
      const firing =
        samples.length === rule.for && samples.every((sample) => breaches(rule, sample));
      if (firing && !isOpen) {
        changes.push({ rule: rule.name, target, route: rule.route, change: "opened", value });
      } else if (!breaches(rule, value) && isOpen) {
        changes.push({ rule: rule.name, target, route: rule.route, change: "resolved", value });
      }
    }
  }

  const at = now.toISOString();
  const insert = db.prepare(
    "INSERT INTO alerts (rule, target, route, opened_at) VALUES (?1, ?2, ?3, ?4)",
  );
  const resolve = db.prepare(
    "UPDATE alerts SET resolved_at = ?2 WHERE rule = ?1 AND target = ?3 AND resolved_at IS NULL",
  );
  if (changes.length > 0) {
    await db.batch(
      changes.map((change) =>
        change.change === "opened"
          ? insert.bind(change.rule, change.target, change.route, at)
          : resolve.bind(change.rule, at, change.target),
      ),
    );
  }
  return changes;
}

// Keyed by route, so a route added to `ROUTES` without a destination fails
// the typecheck.
const DESTINATIONS: Record<Route, (change: AlertChange) => void> = {
  log: (change) => {
    console.log({ event: `monitor.alert.${change.change}`, ...change });
  },
};

export function deliver(change: AlertChange): void {
  DESTINATIONS[change.route](change);
}
