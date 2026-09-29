import { describe, expect, it } from "vitest";
import { authorize, percentEncode } from "./oauth";

// Twitter's published walkthrough of signing one request.
const published = {
  url: new URL("https://api.twitter.com/1.1/statuses/update.json?include_entities=true"),
  body: new URLSearchParams({ status: "Hello Ladies + Gentlemen, a signed OAuth request!" }),
  credentials: {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  },
  nonce: { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: 1318622958 },
};

function headerParams(header: string): Record<string, string> {
  expect(header.startsWith("OAuth ")).toBe(true);
  return Object.fromEntries(
    header
      .slice("OAuth ".length)
      .split(", ")
      .map((pair) => {
        const match = /^([^=]+)="([^"]*)"$/.exec(pair);
        expect(match).not.toBeNull();
        return [match?.[1] ?? "", decodeURIComponent(match?.[2] ?? "")];
      }),
  );
}

describe("authorize", () => {
  it("matches a published HMAC-SHA1 signature", async () => {
    const header = await authorize(
      "POST",
      published.url,
      published.body,
      published.credentials,
      published.nonce,
    );

    expect(headerParams(header)).toEqual({
      oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
      oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      oauth_signature: "hCtSmYh+iHYCEqBWrE7C7hYmtUk=",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1318622958",
      oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      oauth_version: "1.0",
    });
  });

  it("signs without a token for the xAuth exchange", async () => {
    const header = await authorize(
      "POST",
      new URL("https://www.instapaper.com/api/1/oauth/access_token"),
      new URLSearchParams({ x_auth_mode: "client_auth" }),
      { consumerKey: "key", consumerSecret: "secret" },
      published.nonce,
    );

    expect(headerParams(header)).not.toHaveProperty("oauth_token");
  });

  it("draws a fresh nonce per request", async () => {
    const sign = () =>
      authorize("POST", published.url, published.body, published.credentials).then(headerParams);

    const [first, second] = await Promise.all([sign(), sign()]);

    expect(first.oauth_nonce).not.toBe(second.oauth_nonce);
  });
});

describe("percentEncode", () => {
  it("encodes the characters encodeURIComponent leaves alone", () => {
    expect(percentEncode("a!b'c(d)e*f ~-._")).toBe("a%21b%27c%28d%29e%2Af%20~-._");
  });
});
