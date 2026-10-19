import { z } from "zod";

// A copy of the pipeline's refresh in `src/trakt/auth.ts`, cut to what the
// probe needs. The monitor shares no code or credential with the pipeline.

// Trakt issues access tokens for a day. The hourly probe refreshes this far
// ahead, so a failed refresh has hours of retries before the token lapses.
const REFRESH_AHEAD_MS = 6 * 60 * 60 * 1000;

const grant = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  created_at: z.number().int().positive().optional(),
});

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

// The monitor's Trakt application is a PKCE app, which Trakt issues no client
// secret, so a refresh sends the client ID alone. Trakt still wants the
// redirect URI registered on the application, even for a device-flow grant.
export interface TraktCredentials {
  DB: D1Database;
  TRAKT_CLIENT_ID: string;
  TRAKT_REDIRECT_URI: string;
}

// Whether a device login has stored a grant. Without one, the probe leaves
// Trakt out rather than reading as lag 0.
export async function traktLinked(db: D1Database): Promise<boolean> {
  return (await readToken(db)) !== null;
}

export async function traktAccessToken(
  env: TraktCredentials,
  userAgent: string,
  now: Date = new Date(),
): Promise<string> {
  const stored = await readToken(env.DB);
  if (stored === null) {
    throw new Error("no Trakt grant is stored");
  }
  const remaining = Date.parse(stored.expires_at) - now.getTime();
  if (remaining > REFRESH_AHEAD_MS) {
    return stored.access_token;
  }

  let parsed: z.infer<typeof grant>;
  try {
    parsed = await requestRefresh(env, stored, userAgent);
  } catch (error) {
    // Trakt issued nothing, so the token in hand is still the current one. It
    // reads until it lapses, and the next run refreshes again.
    if (remaining > 0) {
      console.error({ event: "monitor.trakt.refresh_failed", error: String(error) });
      return stored.access_token;
    }
    throw error;
  }

  // Trakt has spent the old refresh token, so this grant is the only one left.
  // A grant that fails to store still reads this run, and the next refresh's
  // refusal names the fix.
  try {
    await storeGrant(env.DB, parsed, now);
  } catch (error) {
    console.error({ event: "monitor.trakt.grant_unstored", error: String(error) });
  }
  return parsed.access_token;
}

async function requestRefresh(
  env: TraktCredentials,
  stored: StoredToken,
  userAgent: string,
): Promise<z.infer<typeof grant>> {
  const response = await fetch("https://api.trakt.tv/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({
      refresh_token: stored.refresh_token,
      client_id: env.TRAKT_CLIENT_ID,
      redirect_uri: env.TRAKT_REDIRECT_URI,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.text();
  if (response.status === 400 || response.status === 401) {
    throw new Error(
      body.includes("invalid_grant")
        ? `Trakt refused the refresh token (${response.status}); run \`bun run monitor:trakt-login\``
        : `Trakt refused the token refresh (${response.status}: ${body.slice(0, 200)}); check TRAKT_CLIENT_ID and TRAKT_REDIRECT_URI against the Trakt application`,
    );
  }
  if (!response.ok) {
    throw new Error(`Trakt token refresh answered ${response.status}`);
  }
  return grant.parse(JSON.parse(body));
}

const WRITE_ATTEMPTS = 3;

async function storeGrant(db: D1Database, parsed: z.infer<typeof grant>, now: Date) {
  const issued = parsed.created_at === undefined ? now.getTime() : parsed.created_at * 1000;
  const statement = db
    .prepare(
      "UPDATE trakt_tokens SET access_token = ?1, refresh_token = ?2, expires_at = ?3, updated_at = ?4 WHERE id = 1",
    )
    .bind(
      parsed.access_token,
      parsed.refresh_token,
      new Date(issued + parsed.expires_in * 1000).toISOString(),
      now.toISOString(),
    );
  for (let attempt = 1; ; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a retry follows a failed write
      await statement.run();
      return;
    } catch (error) {
      if (attempt >= WRITE_ATTEMPTS) {
        throw error;
      }
    }
  }
}

function readToken(db: D1Database): Promise<StoredToken | null> {
  return db
    .prepare("SELECT access_token, refresh_token, expires_at FROM trakt_tokens WHERE id = 1")
    .first<StoredToken>();
}
