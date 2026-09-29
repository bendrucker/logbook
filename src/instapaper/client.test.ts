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
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- vitest types asymmetric matchers as `any`
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

  it.each<{
    name: string;
    response: () => Response;
    expected: abstract new (...args: never[]) => Error;
    fields: object;
  }>([
    {
      name: "reads an error array as an error whatever the status",
      response: () => apiError(1241, "Invalid or missing bookmark_id", { status: 200 }),
      expected: InstapaperApiError,
      fields: { code: 1241, status: 200 },
    },
    {
      name: "reads error 1040 as the rate limit, waiting as long as Retry-After says",
      response: () =>
        apiError(1040, "Rate-limit exceeded", { status: 400, headers: { "Retry-After": "120" } }),
      expected: InstapaperRateLimited,
      fields: { retryAfterSeconds: 120 },
    },
    {
      name: "waits an hour on a rate limit that names no wait",
      response: () => apiError(1040, "Rate-limit exceeded"),
      expected: InstapaperRateLimited,
      fields: { retryAfterSeconds: 3600 },
    },
    {
      name: "waits an hour on an empty Retry-After",
      response: () =>
        apiError(1040, "Rate-limit exceeded", { status: 400, headers: { "Retry-After": "" } }),
      expected: InstapaperRateLimited,
      fields: { retryAfterSeconds: 3600 },
    },
    {
      name: "keeps the body of a failure that is not an error array",
      response: () => new Response("upstream down", { status: 503 }),
      expected: InstapaperHttpError,
      fields: { status: 503, body: "upstream down" },
    },
    {
      name: "refuses a 200 whose body is not JSON",
      response: () => new Response("<html>", { status: 200 }),
      expected: InstapaperValidationError,
      fields: { status: 200 },
    },
  ])("$name", async ({ response, expected, fields }) => {
    const stub = stubInstapaper(response);

    const thrown = await verify(stub.fetch).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(expected);
    expect(thrown).toMatchObject(fields);
  });

  it("stops before sending a request past the cap", async () => {
    const stub = stubInstapaper(() => json([USER]));
    const requests = new RequestCap(1);

    await verify(stub.fetch, requests);
    await expect(verify(stub.fetch, requests)).rejects.toBeInstanceOf(RequestCapReached);
    expect(stub.calls).toHaveLength(1);
  });
});
