-- One row per crawl window.
CREATE TABLE crawl_units (
  kind TEXT NOT NULL,
  window TEXT NOT NULL,
  parent TEXT,
  -- pending, done, split, irreducible. No CHECK constraint enforces it.
  status TEXT NOT NULL,
  fetched_at TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, window)
);

CREATE INDEX crawl_units_pending ON crawl_units (kind, window) WHERE status = 'pending';
