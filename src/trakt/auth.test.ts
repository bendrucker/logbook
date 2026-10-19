import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { stubFetch } from "../../test/fetch-stub";
import { readRow } from "../../test/tables";
import { linkTrakt } from "../../test/trakt-fixtures";
import { pollDeviceLogin, type TraktAuthOptions, TraktAuthError, traktAuth } from "./auth";
import { TraktHttpError, TraktRateLimited } from "./client";

const NOW = new Date("2026-10-18T12:00:00.000Z");
// Inside the refresh window with two hours left, and an hour past expiry.
const DUE = "2026-10-18T14:00:00.000Z";
const LAPSED = "2026-10-18T11:00:00.000Z";

function grant(access: string, refresh: string, createdAt = NOW.getTime() / 1000): Response {
  return Response.json({
    access_token: access,
    token_type: "bearer",
    expires_in: 86400,
    refresh_token: refresh,
    scope: "public",
    created_at: createdAt,
  });
}

function refused(error: string, status = 401): Response {
  return Response.json({ error, error_description: "nope" }, { status });
}

const noWait = () => Promise.resolve();

function stored() {
  return readRow<{ access_token: string; refresh_token: string; expires_at: string }>(
    env.DB,
    "SELECT access_token, refresh_token, expires_at FROM trakt_tokens WHERE id = 1",
  );
}

function rotate(access: string, refresh: string) {
  return env.DB.prepare(
    "UPDATE trakt_tokens SET access_token = ?1, refresh_token = ?2 WHERE id = 1",
  )
    .bind(access, refresh)
    .run();
}

async function token(options: TraktAuthOptions): Promise<string> {
  const auth = await traktAuth(env, { now: NOW, wait: noWait, ...options });
  if (auth === null) {
    throw new Error("expected a linked account");
  }
  return auth.accessToken();
}

describe("traktAuth", () => {
  it("is null while no login has linked the account", async () => {
    expect(await traktAuth(env)).toBeNull();
  });

  it("uses the stored token while it has hours left", async () => {
    await linkTrakt(env.DB, "2026-10-19T00:00:00.000Z");
    const { fetch, requests } = stubFetch(() => {
      throw new Error("no refresh is due");
    });

    await expect(token({ fetch })).resolves.toBe("access");
    expect(requests).toEqual([]);
  });

  it("refreshes ahead of expiry with the client ID alone and stores the rotation", async () => {
    await linkTrakt(env.DB, DUE);
    const { fetch, requests } = stubFetch(() => grant("access-2", "refresh-2"));

    await expect(token({ fetch })).resolves.toBe("access-2");
    expect(requests[0]?.url).toBe("https://api.trakt.tv/oauth/token");
    await expect(requests[0]?.json()).resolves.toEqual({
      refresh_token: "refresh",
      client_id: env.TRAKT_CLIENT_ID,
      redirect_uri: env.TRAKT_REDIRECT_URI,
      grant_type: "refresh_token",
    });
    await expect(stored()).resolves.toEqual({
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_at: "2026-10-19T12:00:00.000Z",
    });
  });

  it("resolves once per invocation however many requests ask", async () => {
    await linkTrakt(env.DB, DUE);
    const { fetch, requests } = stubFetch(() => grant("access-2", "refresh-2"));
    const auth = await traktAuth(env, { fetch, now: NOW });

    await Promise.all([auth?.accessToken(), auth?.accessToken()]);

    expect(requests).toHaveLength(1);
  });

  it("takes the token a concurrent refresh stored when its own is spent", async () => {
    await linkTrakt(env.DB, LAPSED);
    const { fetch } = stubFetch(async () => {
      await rotate("theirs", "rotated");
      return refused("invalid_grant");
    });

    await expect(token({ fetch })).resolves.toBe("theirs");
  });

  it("waits for a concurrent refresh whose row lands after the refusal", async () => {
    await linkTrakt(env.DB, LAPSED);
    const { fetch } = stubFetch(() => refused("invalid_grant"));
    const wait = vi.fn<(ms: number) => Promise<void>>(async () => {
      await rotate("theirs", "rotated");
    });

    await expect(token({ fetch, wait })).resolves.toBe("theirs");
    expect(wait).toHaveBeenCalledOnce();
  });

  it("keeps the row a concurrent refresh stored over its own grant", async () => {
    await linkTrakt(env.DB, DUE);
    const { fetch } = stubFetch(async () => {
      await rotate("theirs", "rotated");
      return grant("mine", "mine-refresh");
    });

    await expect(token({ fetch })).resolves.toBe("theirs");
    await expect(stored()).resolves.toMatchObject({ refresh_token: "rotated" });
  });

  it("names a re-login once a spent refresh token meets a lapsed access token", async () => {
    await linkTrakt(env.DB, LAPSED);
    const { fetch } = stubFetch(() => refused("invalid_grant"));

    const failure = token({ fetch });

    await expect(failure).rejects.toBeInstanceOf(TraktAuthError);
    await expect(failure).rejects.toThrow("bun run trakt:login");
  });

  it("names the application settings for any other refusal", async () => {
    await linkTrakt(env.DB, LAPSED);
    const { fetch } = stubFetch(() => refused("invalid_client", 400));

    await expect(token({ fetch })).rejects.toThrow("TRAKT_REDIRECT_URI");
  });

  it("reads with the token in hand while it has time left, whatever the refusal", async () => {
    await linkTrakt(env.DB, DUE);
    for (const response of [
      () => refused("invalid_grant"),
      () => new Response("down", { status: 503 }),
      () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }),
    ]) {
      await expect(token({ fetch: stubFetch(response).fetch })).resolves.toBe("access");
    }
  });

  it("reports a rate-limited refresh as a rate limit on the OAuth endpoint", async () => {
    await linkTrakt(env.DB, LAPSED);
    const { fetch } = stubFetch(
      () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }),
    );

    const failure = token({ fetch });

    await expect(failure).rejects.toBeInstanceOf(TraktRateLimited);
    await expect(failure).rejects.toMatchObject({ retryAfterSeconds: 30, endpoint: "oauth" });
  });

  it("reports a failed refresh of a lapsed token against the OAuth endpoint", async () => {
    await linkTrakt(env.DB, LAPSED);
    const { fetch } = stubFetch(() => new Response("down", { status: 503 }));

    const failure = token({ fetch });

    await expect(failure).rejects.toBeInstanceOf(TraktHttpError);
    await expect(failure).rejects.toMatchObject({ endpoint: "oauth" });
  });

  it("reads with the new token when the issued grant fails to store", async () => {
    await linkTrakt(env.DB, DUE);
    const { fetch } = stubFetch(() => grant("access-2", "refresh-2"));
    const db = new Proxy(env.DB, {
      get(target, key: keyof D1Database) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.startsWith("UPDATE trakt_tokens")) {
              throw new Error("D1 is down");
            }
            return target.prepare(sql);
          };
        }
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const auth = await traktAuth({ ...env, DB: db }, { fetch, now: NOW });

    await expect(auth?.accessToken()).resolves.toBe("access-2");
  });
});

describe("pollDeviceLogin", () => {
  it.each([
    [400, "pending"],
    [404, "invalid"],
    [409, "used"],
    [410, "expired"],
    [418, "denied"],
    [429, "slow_down"],
  ])("reads a %i as %s", async (status, expected) => {
    const { fetch } = stubFetch(() => new Response("", { status }));

    await expect(pollDeviceLogin(env, "device", { fetch, now: NOW })).resolves.toEqual({
      status: expected,
    });
    await expect(stored()).resolves.toBeNull();
  });

  it("stores the grant once the owner approves, replacing an earlier login", async () => {
    await linkTrakt(env.DB);
    const { fetch, requests } = stubFetch(() => grant("access-2", "refresh-2"));

    await expect(pollDeviceLogin(env, "device", { fetch, now: NOW })).resolves.toEqual({
      status: "linked",
      expiresAt: "2026-10-19T12:00:00.000Z",
    });
    await expect(requests[0]?.json()).resolves.toEqual({
      code: "device",
      client_id: env.TRAKT_CLIENT_ID,
    });
    await expect(stored()).resolves.toMatchObject({ refresh_token: "refresh-2" });
  });
});
