import { z } from "zod";
import { MissingSecretError } from "../sync/run";
import { TraktHttpError, TraktResponseError, USER_AGENT } from "./client";

const ENDPOINT = "https://api.trakt.tv";

// Trakt has no personal access token, so the hub reads as the account through
// an OAuth grant from a device login. Access tokens last a day, and the hourly
// cron refreshes this far ahead of expiry so a failed refresh has several more
// hours of tries before the token in hand stops working.
const REFRESH_AHEAD_MS = 6 * 60 * 60 * 1000;

// Trakt requires a redirect URI on refresh even for a grant that never
// redirected. The out-of-band URI is the one its device-flow examples use.
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const tokenGrant = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  created_at: z.number().int().positive().optional(),
});

type TokenGrant = z.infer<typeof tokenGrant>;

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

// Trakt refused the refresh token, and no concurrent refresh replaced it. Only
// a new device login recovers.
export class TraktAuthError extends TraktResponseError {
  constructor(status: number, body: string) {
    super(
      "TraktAuthError",
      `Trakt refused the refresh token (${status}); run \`bun run trakt:login\``,
      status,
      body,
    );
  }
}

export interface TraktAuthOptions {
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  now?: Date;
}

// Resolves the access token once per invocation, refreshing it first when it
// is close to expiry. Every request the invocation sends shares the result.
export class TraktAuth {
  readonly #env: Env;
  readonly #options: TraktAuthOptions;
  #token: Promise<string> | null = null;

  constructor(env: Env, options: TraktAuthOptions = {}) {
    this.#env = env;
    this.#options = options;
  }

  accessToken(): Promise<string> {
    this.#token ??= resolve(this.#env, this.#options);
    return this.#token;
  }
}

// Throws before any request goes out when no device login has stored a grant,
// so the hourly sync skips rather than failing each hour on a credential a
// retry can't supply.
export async function traktAuth(env: Env, options: TraktAuthOptions = {}): Promise<TraktAuth> {
  if ((await readToken(env.DB)) === null) {
    throw new MissingSecretError(NOT_LINKED);
  }
  return new TraktAuth(env, options);
}

const NOT_LINKED = "A Trakt login (`bun run trakt:login`)";

async function resolve(env: Env, options: TraktAuthOptions): Promise<string> {
  const stored = await readToken(env.DB);
  if (stored === null) {
    throw new MissingSecretError(NOT_LINKED);
  }
  const now = options.now ?? new Date();
  const remaining = Date.parse(stored.expires_at) - now.getTime();
  if (remaining > REFRESH_AHEAD_MS) {
    return stored.access_token;
  }

  try {
    return await refresh(env, stored, options, now);
  } catch (error) {
    // A token with time left still reads, and the next invocation refreshes
    // again. A refused refresh token is final, so it surfaces even then.
    if (
      remaining > 0 &&
      !(error instanceof TraktAuthError || error instanceof MissingSecretError)
    ) {
      console.error({ event: "trakt.refresh_failed", error: String(error) });
      return stored.access_token;
    }
    throw error;
  }
}

async function refresh(
  env: Env,
  stored: StoredToken,
  options: TraktAuthOptions,
  now: Date,
): Promise<string> {
  const response = await post(options, "/oauth/token", {
    refresh_token: stored.refresh_token,
    client_id: env.TRAKT_CLIENT_ID,
    client_secret: clientSecret(env),
    redirect_uri: REDIRECT_URI,
    grant_type: "refresh_token",
  });
  const body = await response.text();

  if (response.status === 400 || response.status === 401) {
    // Trakt rotates the refresh token, so a concurrent invocation that
    // refreshed first leaves this one holding a spent token and a fresh row.
    const current = await readToken(env.DB);
    if (current !== null && current.refresh_token !== stored.refresh_token) {
      return current.access_token;
    }
    throw new TraktAuthError(response.status, body);
  }
  if (!response.ok) {
    throw new TraktHttpError(response.status, body);
  }

  const grant = tokenGrant.parse(JSON.parse(body));
  const written = await writeToken(env.DB, grant, now, stored.refresh_token);
  if (!written) {
    // Another invocation stored its own refresh between this one's read and
    // write. Its row is as good as this grant, and keeping it leaves one
    // refresh token in play.
    const current = await readToken(env.DB);
    if (current !== null) {
      return current.access_token;
    }
  }
  return grant.access_token;
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
    client_secret: clientSecret(env),
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

function clientSecret(env: Env): string {
  const secret = env.TRAKT_CLIENT_SECRET;
  if (secret === undefined || secret === "") {
    throw new MissingSecretError("TRAKT_CLIENT_SECRET");
  }
  return secret;
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
