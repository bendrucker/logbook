import { z } from "zod";
import {
  limitName,
  retryAfter,
  TraktHttpError,
  TraktRateLimited,
  TraktResponseError,
  USER_AGENT,
} from "./client";

const ENDPOINT = "https://api.trakt.tv";

// Trakt has no personal access token, so the hub reads as the account through
// an OAuth grant from a device login. Trakt deprecated client secrets for
// PKCE, and its device and refresh calls take the client ID alone. Access
// tokens last a day, and the hourly cron refreshes this far ahead of expiry so
// a failed refresh has several more hours of tries before the token in hand
// stops working.
const REFRESH_AHEAD_MS = 6 * 60 * 60 * 1000;

const tokenGrant = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  created_at: z.number().int().positive().optional(),
});

type TokenGrant = z.infer<typeof tokenGrant>;

export interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

// Trakt refused the refresh outright: a spent or revoked refresh token, or a
// client ID or redirect URI the application doesn't match. Neither recovers on
// a retry.
export class TraktAuthError extends TraktResponseError {
  constructor(status: number, body: string) {
    const revoked = oauthError(body) === "invalid_grant";
    super(
      "TraktAuthError",
      revoked
        ? `Trakt refused the refresh token (${status}); run \`bun run trakt:login\``
        : `Trakt refused the token refresh (${status}: ${body.slice(0, 200)}); check TRAKT_CLIENT_ID and TRAKT_REDIRECT_URI against the Trakt application`,
      status,
      body,
      { endpoint: "oauth" },
    );
  }
}

export interface TraktAuthOptions {
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  now?: Date;
  // How long a refresh refused as spent waits before reading the row again,
  // for a concurrent refresh that rotated the token but hasn't stored it yet.
  wait?: (ms: number) => Promise<void>;
}

// How long a concurrent refresh's write gets to land.
const RACE_WAIT_MS = 2000;

// Attempts at storing a grant Trakt already issued. Once Trakt answers a
// refresh, the old refresh token is spent, so a grant that fails to store
// leaves only a new device login.
const WRITE_ATTEMPTS = 3;

// Resolves the access token once per invocation, refreshing it first when it
// is close to expiry. Every request the invocation sends shares the result.
export class TraktAuth {
  readonly #env: Env;
  readonly #stored: StoredToken;
  readonly #options: TraktAuthOptions;
  #token: Promise<string> | null = null;

  constructor(env: Env, stored: StoredToken, options: TraktAuthOptions = {}) {
    this.#env = env;
    this.#stored = stored;
    this.#options = options;
  }

  accessToken(): Promise<string> {
    this.#token ??= resolve(this.#env, this.#stored, this.#options);
    return this.#token;
  }
}

// Null when no device login has stored a grant, so a caller skips rather than
// failing each hour on a credential a retry can't supply.
export async function traktAuth(
  env: Env,
  options: TraktAuthOptions = {},
): Promise<TraktAuth | null> {
  const stored = await readToken(env.DB);
  return stored === null ? null : new TraktAuth(env, stored, options);
}

export const NOT_LINKED = "A Trakt login (`bun run trakt:login`)";

async function resolve(env: Env, stored: StoredToken, options: TraktAuthOptions): Promise<string> {
  const now = options.now ?? new Date();
  const remaining = Date.parse(stored.expires_at) - now.getTime();
  if (remaining > REFRESH_AHEAD_MS) {
    return stored.access_token;
  }

  let refreshed: Refreshed;
  try {
    refreshed = await requestRefresh(env, stored, options);
  } catch (error) {
    // Trakt issued nothing, so the token in hand is still the current one. It
    // reads until it lapses, and the next invocation refreshes again.
    if (remaining > 0) {
      console.error({ event: "trakt.refresh_failed", error: String(error) });
      return stored.access_token;
    }
    throw error;
  }
  if ("current" in refreshed) {
    return refreshed.current;
  }

  const { grant } = refreshed;
  try {
    if (!(await storeRefresh(env.DB, grant, now, stored.refresh_token))) {
      // Another invocation stored its own refresh between this one's read and
      // write. Its row is as good as this grant, and keeping it leaves one
      // refresh token in play.
      const current = await readToken(env.DB);
      if (current !== null) {
        return current.access_token;
      }
    }
  } catch (error) {
    // The new access token still reads, so this invocation goes on. The next
    // refresh presents a spent token, and its refusal names the fix.
    console.error({ event: "trakt.grant_unstored", error: String(error) });
  }
  return grant.access_token;
}

type Refreshed = { grant: TokenGrant } | { current: string };

// Throws on any refusal, before Trakt has issued a grant.
async function requestRefresh(
  env: Env,
  stored: StoredToken,
  options: TraktAuthOptions,
): Promise<Refreshed> {
  const response = await post(options, "/oauth/token", {
    refresh_token: stored.refresh_token,
    client_id: env.TRAKT_CLIENT_ID,
    // A device-flow grant never redirects, but Trakt still wants the refresh to
    // repeat a redirect URI registered on the application.
    redirect_uri: env.TRAKT_REDIRECT_URI,
    grant_type: "refresh_token",
  });
  const body = await response.text();

  if (response.status === 429) {
    throw new TraktRateLimited(
      retryAfter(response.headers),
      body,
      limitName(response.headers),
      "oauth",
    );
  }
  if (response.status === 400 || response.status === 401) {
    // Trakt rotates the refresh token, so a concurrent invocation that
    // refreshed first leaves this one holding a spent token. Its row may land
    // a moment after Trakt refused this one.
    if (oauthError(body) === "invalid_grant") {
      const current = await rotatedSince(env.DB, stored, options);
      if (current !== null) {
        return { current: current.access_token };
      }
    }
    throw new TraktAuthError(response.status, body);
  }
  if (!response.ok) {
    throw new TraktHttpError(response.status, body, "oauth");
  }
  return { grant: tokenGrant.parse(JSON.parse(body)) };
}

async function rotatedSince(
  db: D1Database,
  stored: StoredToken,
  options: TraktAuthOptions,
): Promise<StoredToken | null> {
  const wait = options.wait ?? (async (ms: number) => scheduler.wait(ms));
  for (const delay of [0, RACE_WAIT_MS]) {
    if (delay > 0) {
      // oxlint-disable-next-line no-await-in-loop -- the second read waits on the first
      await wait(delay);
    }
    // oxlint-disable-next-line no-await-in-loop -- each read follows the wait before it
    const current = await readToken(db);
    if (current !== null && current.refresh_token !== stored.refresh_token) {
      return current;
    }
  }
  return null;
}

async function storeRefresh(
  db: D1Database,
  grant: TokenGrant,
  now: Date,
  replacing: string,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a retry follows a failed write
      return await writeToken(db, grant, now, replacing);
    } catch (error) {
      if (attempt >= WRITE_ATTEMPTS) {
        throw error;
      }
    }
  }
}

const oauthErrorBody = z.object({ error: z.string() });

// Trakt's OAuth errors name themselves in an `error` field, as RFC 6749 has it.
function oauthError(body: string): string | null {
  try {
    return oauthErrorBody.parse(JSON.parse(body)).error;
  } catch {
    return null;
  }
}

export type DeviceCode = z.infer<typeof deviceCode>;

const deviceCode = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_url: z.string(),
  expires_in: z.number().int(),
  interval: z.number().int(),
});

// The first half of a device login: a code for the account owner to enter at
// Trakt's verification URL.
export async function startDeviceLogin(
  env: Env,
  options: TraktAuthOptions = {},
): Promise<DeviceCode> {
  const response = await post(options, "/oauth/device/code", { client_id: env.TRAKT_CLIENT_ID });
  const body = await response.text();
  if (!response.ok) {
    throw new TraktHttpError(response.status, body);
  }
  return deviceCode.parse(JSON.parse(body));
}

type DeviceLoginWaiting = "pending" | "slow_down" | "invalid" | "used" | "expired" | "denied";

export type DeviceLoginStatus =
  | { status: "linked"; expiresAt: string }
  | { status: DeviceLoginWaiting };

// Trakt answers each state of a device login with its own status code.
const DEVICE_STATUSES: Partial<Record<number, DeviceLoginWaiting>> = {
  400: "pending",
  404: "invalid",
  409: "used",
  410: "expired",
  418: "denied",
  429: "slow_down",
};

// One poll of a device login, which stores the grant once the owner approves.
export async function pollDeviceLogin(
  env: Env,
  code: string,
  options: TraktAuthOptions = {},
): Promise<DeviceLoginStatus> {
  const response = await post(options, "/oauth/device/token", {
    code,
    client_id: env.TRAKT_CLIENT_ID,
  });
  const body = await response.text();
  const status = DEVICE_STATUSES[response.status];
  if (status !== undefined) {
    return { status };
  }
  if (!response.ok) {
    throw new TraktHttpError(response.status, body);
  }

  const grant = tokenGrant.parse(JSON.parse(body));
  const now = options.now ?? new Date();
  await writeToken(env.DB, grant, now, null);
  return { status: "linked", expiresAt: expiresAt(grant, now) };
}

async function post(
  options: TraktAuthOptions,
  path: string,
  payload: Record<string, string>,
): Promise<Response> {
  const transport = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return transport(new URL(path, options.endpoint ?? ENDPOINT), {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify(payload),
  });
}

// `created_at` is Trakt's clock, which keeps a slow round trip from stretching
// the lifetime past what Trakt granted.
function expiresAt(grant: TokenGrant, now: Date): string {
  const issued = grant.created_at === undefined ? now.getTime() : grant.created_at * 1000;
  return new Date(issued + grant.expires_in * 1000).toISOString();
}

function readToken(db: D1Database): Promise<StoredToken | null> {
  return db
    .prepare("SELECT access_token, refresh_token, expires_at FROM trakt_tokens WHERE id = 1")
    .first<StoredToken>();
}

// A refresh replaces only the row it read, so of two concurrent refreshes the
// second write is a no-op rather than storing a token Trakt already rotated.
// A device login, with no prior token, replaces whatever is there.
async function writeToken(
  db: D1Database,
  grant: TokenGrant,
  now: Date,
  replacing: string | null,
): Promise<boolean> {
  const values = [
    grant.access_token,
    grant.refresh_token,
    expiresAt(grant, now),
    now.toISOString(),
  ];
  const result =
    replacing === null
      ? await db
          .prepare(
            "INSERT INTO trakt_tokens (id, access_token, refresh_token, expires_at, updated_at) VALUES (1, ?1, ?2, ?3, ?4)" +
              " ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token," +
              " expires_at = excluded.expires_at, updated_at = excluded.updated_at",
          )
          .bind(...values)
          .run()
      : await db
          .prepare(
            "UPDATE trakt_tokens SET access_token = ?1, refresh_token = ?2, expires_at = ?3, updated_at = ?4" +
              " WHERE id = 1 AND refresh_token = ?5",
          )
          .bind(...values, replacing)
          .run();
  return result.meta.changes > 0;
}
