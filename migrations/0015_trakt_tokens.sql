-- The OAuth grant the Trakt reads authenticate with. One row, since the hub
-- reads one account. Trakt rotates the refresh token on every refresh, so this
-- lives in D1 rather than KV: a stale read of a rotated token is a dead
-- credential, and only a new device login revives it.
CREATE TABLE trakt_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
