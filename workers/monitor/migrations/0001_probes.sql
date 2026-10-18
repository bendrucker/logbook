-- One row per probe of one output per run. `good` is the SLI's numerator,
-- every row its denominator. `value` and `threshold` share a unit the probe
-- names: seconds for freshness.
CREATE TABLE probes (
  id INTEGER PRIMARY KEY,
  probed_at TEXT NOT NULL,
  probe TEXT NOT NULL,
  target TEXT NOT NULL,
  good INTEGER NOT NULL,
  value REAL,
  threshold REAL NOT NULL
);

CREATE INDEX probes_target ON probes (probe, target, probed_at);
