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
  if (response.status === 400 || response.status === 401) {
    throw new Error(
      `Trakt refused the refresh token (${response.status}); run \`bun run monitor:trakt-login\``,
    );
  }
  if (!response.ok) {
    // The token in hand still reads until it lapses, and the next run retries.
    if (remaining > 0) {
      console.error({ event: "monitor.trakt.refresh_failed", status: response.status });
      return stored.access_token;
    }
    throw new Error(`Trakt token refresh answered ${response.status}`);
  }

  const parsed = grant.parse(await response.json());
  const issued = parsed.created_at === undefined ? now.getTime() : parsed.created_at * 1000;
  await env.DB.prepare(
    "UPDATE trakt_tokens SET access_token = ?1, refresh_token = ?2, expires_at = ?3, updated_at = ?4 WHERE id = 1",
  )
    .bind(
      parsed.access_token,
      parsed.refresh_token,
      new Date(issued + parsed.expires_in * 1000).toISOString(),
      now.toISOString(),
    )
    .run();
  return parsed.access_token;
}

function readToken(db: D1Database): Promise<StoredToken | null> {
  return db
    .prepare("SELECT access_token, refresh_token, expires_at FROM trakt_tokens WHERE id = 1")
    .first<StoredToken>();
}
