-- The monitor's own Trakt OAuth grant, from a device login against its own
-- Trakt application, so a revoked or broken grant in the pipeline can't blind
-- the probe that would notice it. One row. D1 rather than KV because Trakt
-- rotates the refresh token on every refresh, and a stale read of a rotated
-- token is a dead credential.
CREATE TABLE trakt_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
