-- One row per scheduled invocation, written before any work so an invocation
-- that dies mid-flight shows as one that never finished. A run log alone cannot
-- tell an hour the cron never fired from an hour every kind was skipped.
CREATE TABLE invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The cron expression that fired, which tells the hourly sync from the
  -- nightly lake build.
  cron TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

CREATE INDEX invocations_cron_started_at ON invocations (cron, started_at);

-- How far behind now each watermark stood at the end of an hourly sync, and
-- the newest successful lake build under kind `lake`. A watermark only holds
-- its latest value, so freshness over time needs a sample of it each hour.
CREATE TABLE sli_samples (
  sampled_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  watermark TEXT,
  -- Null when the lake has never built successfully.
  lag_seconds INTEGER,
  PRIMARY KEY (sampled_at, kind)
);

CREATE INDEX sli_samples_kind_sampled_at ON sli_samples (kind, sampled_at);
