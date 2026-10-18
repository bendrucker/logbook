-- One row per measurement of one output per run. The monitor records what it
-- measured and nothing about whether that is good: thresholds live in the
-- alert rules, so a rule changes without rewriting history.
CREATE TABLE metrics (
  id INTEGER PRIMARY KEY,
  sampled_at TEXT NOT NULL,
  metric TEXT NOT NULL,
  target TEXT NOT NULL,
  value REAL NOT NULL
);

CREATE INDEX metrics_target ON metrics (metric, target, sampled_at);

-- One row per incident of one rule on one target. `route` is where the rule
-- sent it when it opened.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  target TEXT NOT NULL,
  route TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE UNIQUE INDEX alerts_open ON alerts (rule, target) WHERE resolved_at IS NULL;
