import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { stubFetch } from "../../test/fetch-stub";
import { readRow } from "../../test/tables";
import { linkTrakt } from "../../test/trakt-fixtures";
import { MissingSecretError } from "../sync/run";
import { pollDeviceLogin, TraktAuth, TraktAuthError, traktAuth } from "./auth";

const NOW = new Date("2026-10-18T12:00:00.000Z");

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

function stored() {
  return readRow<{ access_token: string; refresh_token: string; expires_at: string }>(
    env.DB,
    "SELECT access_token, refresh_token, expires_at FROM trakt_tokens WHERE id = 1",
  );
}

describe("traktAuth", () => {
  it("refuses before any request while no login has linked the account", async () => {
    await expect(traktAuth(env)).rejects.toThrow(MissingSecretError);
  });

  it("uses the stored token while it has hours left", async () => {
    await linkTrakt(env.DB, "2026-10-19T00:00:00.000Z");
    const { fetch, requests } = stubFetch(() => {
      throw new Error("no refresh is due");
    });

    const auth = await traktAuth(env, { fetch, now: NOW });

    await expect(auth.accessToken()).resolves.toBe("access");
    expect(requests).toEqual([]);
  });

  it("refreshes ahead of expiry and stores the rotated refresh token", async () => {
    await linkTrakt(env.DB, "2026-10-18T14:00:00.000Z");
    const { fetch, requests } = stubFetch(() => grant("access-2", "refresh-2"));

    const auth = await traktAuth(env, { fetch, now: NOW });

    await expect(auth.accessToken()).resolves.toBe("access-2");
    const [request] = requests;
    expect(request?.url).toBe("https://api.trakt.tv/oauth/token");
    await expect(request?.json()).resolves.toEqual({
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
    await linkTrakt(env.DB, "2026-10-18T14:00:00.000Z");
    const { fetch, requests } = stubFetch(() => grant("access-2", "refresh-2"));
    const auth = new TraktAuth(env, { fetch, now: NOW });

    await Promise.all([auth.accessToken(), auth.accessToken()]);

    expect(requests).toHaveLength(1);
  });

  it("takes the token a concurrent refresh stored when its own refresh token is spent", async () => {
    await linkTrakt(env.DB, "2026-10-18T14:00:00.000Z");
    const { fetch } = stubFetch(async () => {
      await env.DB.prepare(
        "UPDATE trakt_tokens SET access_token = 'theirs', refresh_token = 'rotated' WHERE id = 1",
      ).run();
      return new Response('{"error":"invalid_grant"}', { status: 401 });
    });

    const auth = await traktAuth(env, { fetch, now: NOW });

    await expect(auth.accessToken()).resolves.toBe("theirs");
  });

  it("keeps the row a concurrent refresh stored over its own grant", async () => {
    await linkTrakt(env.DB, "2026-10-18T14:00:00.000Z");
    const { fetch } = stubFetch(async () => {
      await env.DB.prepare(
        "UPDATE trakt_tokens SET access_token = 'theirs', refresh_token = 'rotated' WHERE id = 1",
      ).run();
      return grant("mine", "mine-refresh");
    });

    const auth = await traktAuth(env, { fetch, now: NOW });

    await expect(auth.accessToken()).resolves.toBe("theirs");
    await expect(stored()).resolves.toMatchObject({ refresh_token: "rotated" });
  });

  it("fails on a refused refresh token, even with time left", async () => {
    await linkTrakt(env.DB, "2026-10-18T14:00:00.000Z");
    const { fetch } = stubFetch(() => new Response("{}", { status: 401 }));

    const auth = await traktAuth(env, { fetch, now: NOW });

    await expect(auth.accessToken()).rejects.toThrow(TraktAuthError);
  });

  it("reads with the token in hand when a refresh fails for any other reason", async () => {
    await linkTrakt(env.DB, "2026-10-18T14:00:00.000Z");
    const { fetch } = stubFetch(() => new Response("down", { status: 503 }));

    const auth = await traktAuth(env, { fetch, now: NOW });

    await expect(auth.accessToken()).resolves.toBe("access");
  });

  it("fails once the token has expired and the refresh fails", async () => {
    await linkTrakt(env.DB, "2026-10-18T11:00:00.000Z");
    const { fetch } = stubFetch(() => new Response("down", { status: 503 }));

    const auth = await traktAuth(env, { fetch, now: NOW });

    await expect(auth.accessToken()).rejects.toThrow("503");
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
