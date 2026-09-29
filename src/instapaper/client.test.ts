import { describe, expect, it } from "vitest";
import { apiError, folder, folders, json, stubInstapaper } from "../../test/instapaper-fixtures";
import { RequestCap, RequestCapReached } from "../request-cap";
import { InstapaperClient, InstapaperRateLimited, InstapaperResponseError } from "./client";

function client(fetch: typeof globalThis.fetch, requests?: RequestCap): InstapaperClient {
  return new InstapaperClient("access-token", {
    fetch,
    ...(requests === undefined ? {} : { requests }),
  });
}

describe("InstapaperClient", () => {
  it("sends the token as a bearer and keeps the bytes it validated", async () => {
    const stub = stubInstapaper(() => folders(folder(7, "Essays")));

    const response = await client(stub.fetch).folders();

    expect(response.data.folders).toEqual([
      { id: 7, title: "Essays", slug: "essays", position: 7, public: false },
    ]);
    expect(response.body).toBe(JSON.stringify({ folders: [folder(7, "Essays")] }));
    expect(stub.calls).toEqual([
      { method: "GET", path: "/api/2/folders", query: {}, authorization: "Bearer access-token" },
    ]);
  });

  it("pages the change listing by offset at the largest page size", async () => {
    const stub = stubInstapaper(() => json({ bookmarks: [], total: 0 }));

    const response = await client(stub.fetch).changes(1_788_220_800, 500);

    expect(response.data).toEqual({ bookmarks: [], deleted_ids: [] });
    expect(stub.calls[0]?.query).toEqual({ since: "1788220800", limit: "500", offset: "500" });
  });

  it.each<{
    name: string;
    response: () => Response;
    expected: abstract new (...args: never[]) => Error;
    fields: object;
  }>([
    {
      name: "reads a 429 as the rate limit, waiting as long as Retry-After says",
      response: () => apiError(429, "Rate limit exceeded", { headers: { "Retry-After": "120" } }),
      expected: InstapaperRateLimited,
      fields: { retryAfterSeconds: 120, status: 429 },
    },
    {
      name: "waits an hour on a rate limit that names no wait",
      response: () => apiError(429, "Rate limit exceeded"),
      expected: InstapaperRateLimited,
      fields: { retryAfterSeconds: 3600 },
    },
    {
      name: "waits an hour on an empty Retry-After",
      response: () => apiError(429, "Rate limit exceeded", { headers: { "Retry-After": "" } }),
      expected: InstapaperRateLimited,
      fields: { retryAfterSeconds: 3600 },
    },
    {
      name: "keeps the body of an error status",
      response: () => new Response("upstream down", { status: 503 }),
      expected: InstapaperResponseError,
      fields: { name: "InstapaperApiError", status: 503, body: "upstream down" },
    },
    {
      name: "refuses a 200 that does not match the schema",
      response: () => json({ folders: [{ id: "seven" }] }),
      expected: InstapaperResponseError,
      fields: { name: "InstapaperValidationError", status: 200 },
    },
  ])("$name", async ({ response, expected, fields }) => {
    const stub = stubInstapaper(response);

    const thrown = await client(stub.fetch)
      .folders()
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(expected);
    expect(thrown).toMatchObject(fields);
  });

  it("stops before sending a request past the cap", async () => {
    const stub = stubInstapaper(() => folders());
    const instapaper = client(stub.fetch, new RequestCap(1));

    await instapaper.folders();
    await expect(instapaper.folders()).rejects.toBeInstanceOf(RequestCapReached);
    expect(stub.calls).toHaveLength(1);
  });
});
