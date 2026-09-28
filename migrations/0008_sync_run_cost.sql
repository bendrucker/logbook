-- The rate budget's spend ledger is the sum of `cost` over the runs started in
-- the current rate window, so each run records the points it spent and the
-- last `remaining` GitHub reported to it.
ALTER TABLE sync_runs ADD COLUMN cost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN rate_remaining INTEGER;
CREATE INDEX sync_runs_started_at ON sync_runs (started_at);
