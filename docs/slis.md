# SLIs

What the run log, the invocation log, and the hourly freshness samples measure, as D1 queries. The thresholds are drafts to calibrate against a few weeks of clean data. Nothing alerts on them yet.

Run any of these with `bun run wrangler d1 execute DB --remote --command "..."`. Each reads the last seven days. Timestamps are ISO strings, so a range is a string comparison against `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`.

## Sources

- **`sli_samples`**: written at the end of every hourly invocation, whatever the sources did. One row per kind holding a watermark, with `lag_seconds` as now less the watermark. Kind `lake` holds the newest successful `lake_builds.finished_at` and its lag. Frontier-only kinds have no watermark and no sample.
- **`invocations`**: one row per `scheduled()` call, written before any work. `finished_at` null is an invocation that died. `error` holds what the invocation threw.
- **`sync_runs`**: `outcome` and `reason`, from `src/sync/outcome.ts`. `requests` counts the upstream requests a run sent and `rate_limited_requests` the ones refused on a rate limit: a 429 from any source, or a GitHub secondary limit. Runs from before migration `0014` read 0 for both.
- **`lake_builds`**: per-table `row_counts` on each successful build.

## Freshness

Good: samples whose lag is under the kind's threshold. Valid: every sample of the kind. A null lag, a lake that has never built, counts as stale.

Draft thresholds: 3h for the GitHub search kinds and `contributions`, 6h for Trakt, 3h for Instapaper, 26h for the lake.

```sql
SELECT kind,
  ROUND(AVG(lag_seconds IS NOT NULL AND lag_seconds < CASE
    WHEN kind = 'lake' THEN 26 * 3600
    WHEN kind LIKE 'trakt-%' THEN 6 * 3600
    ELSE 3 * 3600
  END), 4) AS fresh,
  MAX(lag_seconds) AS worst_lag_seconds,
  COUNT(*) AS samples
FROM sli_samples
WHERE sampled_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
GROUP BY kind;
```

## Run Success

Good: runs that ended `ok` or `rate_limited`. Valid: finished runs, skips excluded. A rate limit costs freshness, which the freshness SLI already counts, rather than correctness.

```sql
SELECT kind,
  ROUND(AVG(outcome IN ('ok', 'rate_limited')), 4) AS success,
  COUNT(*) AS runs
FROM sync_runs
WHERE finished_at IS NOT NULL AND outcome != 'skipped'
  AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
GROUP BY kind;
```

## Rate-Limit Stops

Rate-limited runs over finished runs, skips excluded, by reason. A rise in `rate_limit.budget` is ours to tune through the `RATE_*` vars. The others come from upstream.

```sql
SELECT reason, COUNT(*) AS stops,
  ROUND(COUNT(*) * 1.0 / (
    SELECT COUNT(*) FROM sync_runs
    WHERE finished_at IS NOT NULL AND outcome != 'skipped'
      AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
  ), 4) AS share
FROM sync_runs
WHERE outcome = 'rate_limited'
  AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
GROUP BY reason;
```

## Request Rate Limits

Rate-limited requests over requests sent, per kind. Rate-limit stops count runs, and one run can send a hundred requests or one, so this is the rate the upstream actually refuses at. A stop on the run's own budget or cap sends nothing and counts in neither column.

```sql
SELECT kind,
  SUM(rate_limited_requests) AS rate_limited,
  SUM(requests) AS requests,
  ROUND(SUM(rate_limited_requests) * 1.0 / NULLIF(SUM(requests), 0), 4) AS rate
FROM sync_runs
WHERE finished_at IS NOT NULL
  AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
GROUP BY kind;
```

## Coverage Lost to Limits

Kinds that never ran because an earlier kind's rate limit ended the invocation, per kind.

```sql
SELECT kind, COUNT(*) AS skipped
FROM sync_runs
WHERE outcome = 'skipped' AND reason = 'skip.rate_limited'
  AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
GROUP BY kind;
```

## Skips by Reason

Every skip, so a kind that stopped running for a missing secret or a missing watermark shows up.

```sql
SELECT kind, reason, COUNT(*) AS skipped
FROM sync_runs
WHERE outcome = 'skipped'
  AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
GROUP BY kind, reason;
```

## Invocation Coverage

Good: hours holding a finished hourly invocation, failed or not. Valid: hours elapsed. A missing hour is a cron that never fired or an invocation that died before finishing. Run success already counts the failures.

```sql
SELECT ROUND(COUNT(DISTINCT substr(started_at, 1, 13)) / (7 * 24.0), 4) AS coverage
FROM invocations
WHERE cron = '0 * * * *' AND finished_at IS NOT NULL
  AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days');
```

## Lake Completeness

Each table's row count against the previous successful build. The event tables only grow, so a drop is a symptom: a D1 query that read less than it should have, or rows deleted upstream of the lake. The Apple Music library, preference, and track tables can shrink when an import replaces an older export.

```sql
WITH builds AS (
  SELECT id, finished_at, row_counts,
    LAG(row_counts) OVER (ORDER BY finished_at) AS previous
  FROM lake_builds
  WHERE finished_at IS NOT NULL AND error IS NULL
)
SELECT builds.finished_at, current.key AS lake_table,
  json_extract(builds.previous, '$.' || current.key) AS before,
  current.value AS after
FROM builds, json_each(builds.row_counts) AS current
WHERE builds.previous IS NOT NULL
  AND builds.finished_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
  AND current.value < json_extract(builds.previous, '$.' || current.key);
```
