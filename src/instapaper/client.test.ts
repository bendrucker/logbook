import { describe, expect, it } from "vitest";
import { apiError, json, stubInstapaper, USER } from "../../test/instapaper-fixtures";
import { RequestCap, RequestCapReached } from "../request-cap";
import {
  InstapaperApiError,
  InstapaperHttpError,
  InstapaperRateLimited,
  InstapaperValidationError,
  instapaperPost,
} from "./client";
import { verifyCredentialsResponse } from "./schema";

const CREDENTIALS = {
  consumerKey: "consumer-key",
  consumerSecret: "consumer-secret",
  token: "access-token",
  tokenSecret: "access-secret",
};

function verify(fetch: typeof globalThis.fetch, requests?: RequestCap) {
  return instapaperPost(
    CREDENTIALS,
    "/api/1/account/verify_credentials",
    { extra: "a b" },
    verifyCredentialsResponse,
    { fetch, ...(requests === undefined ? {} : { requests }) },
  );
}

describe("instapaperPost", () => {
  it("posts a signed form and validates the answer", async () => {
    const stub = stubInstapaper(() => json([USER]));

    const response = await verify(stub.fetch);

    expect(response.data).toEqual([USER]);
    expect(response.body).toBe(JSON.stringify([USER]));
    expect(stub.calls).toEqual([
      {
        path: "/api/1/account/verify_credentials",
        form: { extra: "a b" },
        authorization: expect.stringMatching(/^OAuth oauth_consumer_key="consumer-key", /),
      },
    ]);
    expect(stub.calls[0]?.authorization).toContain('oauth_token="access-token"');
    expect(stub.calls[0]?.authorization).toMatch(/oauth_signature="[^"]+"$/);
  });

  it("keeps only the items of the type it asked for", async () => {
    const stub = stubInstapaper(() => json([{ type: "meta" }, USER]));

    expect((await verify(stub.fetch)).data).toEqual([USER]);
  });

  it("reads an error array as an error whatever the status", async () => {
    const stub = stubInstapaper(() =>
      apiError(1241, "Invalid or missing bookmark_id", { status: 200 }),
    );

    const error = await verify(stub.fetch).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InstapaperApiError);
    expect(error).toMatchObject({ code: 1241, status: 200 });
  });

  it("reads error 1040 as the rate limit, waiting as long as Retry-After says", async () => {
    const stub = stubInstapaper(() =>
      apiError(1040, "Rate-limit exceeded", { status: 400, headers: { "Retry-After": "120" } }),
    );

    const error = await verify(stub.fetch).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InstapaperRateLimited);
    expect(error).toMatchObject({ retryAfterSeconds: 120 });
  });

  it("waits an hour on a rate limit that names no wait", async () => {
    const stub = stubInstapaper(() => apiError(1040, "Rate-limit exceeded"));

    await expect(verify(stub.fetch)).rejects.toMatchObject({ retryAfterSeconds: 3600 });
  });

  it("keeps the body of a failure that is not an error array", async () => {
    const stub = stubInstapaper(() => new Response("upstream down", { status: 503 }));

    const error = await verify(stub.fetch).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InstapaperHttpError);
    expect(error).toMatchObject({ status: 503, body: "upstream down" });
  });

  it("refuses a 200 whose body is not JSON", async () => {
    const stub = stubInstapaper(() => new Response("<html>", { status: 200 }));

    await expect(verify(stub.fetch)).rejects.toBeInstanceOf(InstapaperValidationError);
  });

  it("stops before sending a request past the cap", async () => {
    const stub = stubInstapaper(() => json([USER]));
    const requests = new RequestCap(1);

    await verify(stub.fetch, requests);
    await expect(verify(stub.fetch, requests)).rejects.toBeInstanceOf(RequestCapReached);
    expect(stub.calls).toHaveLength(1);
  });
});
