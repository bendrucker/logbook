import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traktAccessToken, type TraktCredentials } from "./trakt-auth";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const credentials: TraktCredentials = {
  DB: env.DB,
  TRAKT_CLIENT_ID: "client",
  TRAKT_REDIRECT_URI: "https://bendrucker.me/",
};

async function link(expiresAt: string) {
  await env.DB.prepare(
    "INSERT INTO trakt_tokens VALUES (1, 'access', 'refresh', ?1, '2026-10-18T00:00:00.000Z')",
  )
    .bind(expiresAt)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM trakt_tokens").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("traktAccessToken", () => {
  it("uses the stored token while it has hours left", async () => {
    await link("2026-10-19T00:00:00.000Z");
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(traktAccessToken(credentials, "ua", NOW)).resolves.toBe("access");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes ahead of expiry and stores the rotated refresh token", async () => {
    await link("2026-10-18T14:00:00.000Z");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 86400,
        created_at: NOW.getTime() / 1000,
      }),
    );

    await expect(traktAccessToken(credentials, "ua", NOW)).resolves.toBe("access-2");
    const [input, init] = fetch.mock.calls[0] ?? [];
    await expect(new Request(input ?? "", init).json()).resolves.toEqual({
      refresh_token: "refresh",
      client_id: "client",
      redirect_uri: "https://bendrucker.me/",
      grant_type: "refresh_token",
    });
    const row = await env.DB.prepare(
      "SELECT refresh_token, expires_at FROM trakt_tokens WHERE id = 1",
    ).first();
    expect(row).toEqual({ refresh_token: "refresh-2", expires_at: "2026-10-19T12:00:00.000Z" });
  });

  it("reads with the token in hand when a refresh fails with time left", async () => {
    await link("2026-10-18T14:00:00.000Z");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));

    await expect(traktAccessToken(credentials, "ua", NOW)).resolves.toBe("access");
  });

  it("fails on a refused refresh token", async () => {
    await link("2026-10-18T14:00:00.000Z");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    await expect(traktAccessToken(credentials, "ua", NOW)).rejects.toThrow("refused");
  });
});
