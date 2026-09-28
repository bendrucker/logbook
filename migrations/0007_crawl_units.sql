-- One row per crawl window. A backfill enqueues roots and the frontier drains
-- them, splitting any window whose response dropped data.
CREATE TABLE crawl_units (
  kind TEXT NOT NULL,
  window TEXT NOT NULL,
  parent TEXT,
  -- pending, done, split, irreducible. No CHECK, matching sync_runs.kind.
  status TEXT NOT NULL,
  fetched_at TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, window)
);

CREATE INDEX crawl_units_pending ON crawl_units (kind, window) WHERE status = 'pending';
