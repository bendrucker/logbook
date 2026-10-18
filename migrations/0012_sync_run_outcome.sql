-- `error` records every run that stopped early, rate limits included, so a
-- failure count read from it is mostly 429s. `outcome` says how the run ended
-- and `reason` why, which `src/sync/outcome.ts` defines. `error` keeps the
-- message for any outcome but `ok`.
ALTER TABLE sync_runs ADD COLUMN outcome TEXT;
ALTER TABLE sync_runs ADD COLUMN reason TEXT;
-- The instant a rate-limited run was told to wait for.
ALTER TABLE sync_runs ADD COLUMN resume_at TEXT;

-- Runs recorded before this migration are classified from the error name
-- `describe` wrote ahead of the colon. A run that never finished stays null.
UPDATE sync_runs
SET
  outcome = CASE
    WHEN error IS NULL THEN 'ok'
    WHEN error LIKE 'TraktRateLimited:%'
      OR error LIKE 'InstapaperRateLimited:%'
      OR error LIKE 'SecondaryRateLimited:%'
      OR error LIKE 'BudgetRefused:%'
      OR error LIKE 'RequestCapReached:%' THEN 'rate_limited'
    ELSE 'failed'
  END,
  reason = CASE
    WHEN error IS NULL THEN NULL
    WHEN error LIKE 'TraktRateLimited:%' OR error LIKE 'InstapaperRateLimited:%' THEN 'rate_limit.upstream'
    WHEN error LIKE 'SecondaryRateLimited:%' THEN 'rate_limit.secondary'
    WHEN error LIKE 'BudgetRefused:%' OR error LIKE 'RequestCapReached:%' THEN 'rate_limit.budget'
    WHEN error LIKE 'ResponseValidationError:%'
      OR error LIKE 'RepeatedCursorError:%'
      OR error LIKE 'TraktValidationError:%'
      OR error LIKE 'InstapaperValidationError:%' THEN 'upstream.contract'
    WHEN error LIKE 'GraphQLQueryError:%' THEN 'upstream.graphql'
    WHEN error LIKE 'GitHubHttpError: GitHub GraphQL responded 5%'
      OR error LIKE 'TraktHttpError: Trakt responded 5%'
      OR error LIKE 'InstapaperApiError: Instapaper responded 5%' THEN 'upstream.5xx'
    WHEN error LIKE 'GitHubHttpError:%'
      OR error LIKE 'TraktHttpError:%'
      OR error LIKE 'InstapaperApiError:%' THEN 'upstream.4xx'
    WHEN error LIKE 'MissingSecretError:%' OR error LIKE 'UnknownUserError:%' THEN 'config'
    ELSE 'internal'
  END
WHERE finished_at IS NOT NULL;

DROP INDEX sync_runs_failures;
CREATE INDEX sync_runs_failures ON sync_runs (started_at) WHERE outcome = 'failed';
CREATE INDEX sync_runs_outcome ON sync_runs (kind, outcome, started_at);
