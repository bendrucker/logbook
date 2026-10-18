-- Upstream requests each run sent, and how many came back refused on a rate
-- limit: a 429 from any source, or a GitHub secondary limit answered 403. A run
-- stopped by its own budget or cap sent nothing for that stop, so this counts
-- the limits the upstream enforced rather than the ones the hub did.
ALTER TABLE sync_runs ADD COLUMN requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN rate_limited_requests INTEGER NOT NULL DEFAULT 0;
