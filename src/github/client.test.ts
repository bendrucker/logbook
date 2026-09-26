import { describe, expect, it } from "vitest";
import { jsonResponse, rateLimit, requestBody } from "../../test/github-fixtures";
import { stubFetch } from "../../test/fetch-stub";
import {
  graphql,
  GitHubHttpError,
  GraphQLQueryError,
  RateLimitExhausted,
  ResponseValidationError,
  type GraphQLOptions,
} from "./client";

const ENDPOINT = "https://api.github.test/graphql";

function options(fetch: typeof globalThis.fetch): GraphQLOptions {
  return { fetch, endpoint: ENDPOINT };
}

describe("graphql", () => {
  it("posts the query and returns the data, body, and rate limit", async () => {
    const stub = stubFetch(() => jsonResponse({ data: { search: {}, rateLimit: rateLimit() } }));

    const response = await graphql("t0ken", "query Q { x }", { first: 100 }, options(stub.fetch));

    expect(response.rateLimit).toEqual(rateLimit());
    expect(response.data).toEqual({ search: {}, rateLimit: rateLimit() });
    expect(JSON.parse(response.body)).toEqual({ data: { search: {}, rateLimit: rateLimit() } });

    const [request] = stub.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(ENDPOINT);
    expect(request?.headers.get("Authorization")).toBe("Bearer t0ken");
    expect(request?.headers.get("User-Agent")).toContain("logbook");
    await expect(requestBody(request!)).resolves.toEqual({
      query: "query Q { x }",
      variables: { first: 100 },
    });
  });

  it("throws a typed error on a non-200", async () => {
    const stub = stubFetch(() => new Response("bad credentials", { status: 401 }));

    await expect(graphql("t0ken", "query Q { x }", {}, options(stub.fetch))).rejects.toThrow(
      GitHubHttpError,
    );
  });

  it("carries the status and body on a non-200", async () => {
    const stub = stubFetch(() => new Response("bad credentials", { status: 401 }));

    const error = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GitHubHttpError);
    expect(error).toMatchObject({ status: 401, body: "bad credentials" });
  });

  it("throws on GraphQL errors even under a 200", async () => {
    const stub = stubFetch(() =>
      jsonResponse({ data: null, errors: [{ message: "Field 'nope' doesn't exist" }] }),
    );

    const error = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphQLQueryError);
    expect(error).toMatchObject({ errors: [{ message: "Field 'nope' doesn't exist" }] });
  });

  it("throws the typed error when a request-level failure omits data entirely", async () => {
    const stub = stubFetch(() => jsonResponse({ errors: [{ message: "Query has node limit" }] }));

    const error = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphQLQueryError);
    expect(error).toMatchObject({ errors: [{ message: "Query has node limit" }] });
  });

  it("stops on the rate limit floor rather than waiting for a 403", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        data: { rateLimit: rateLimit({ remaining: 40, resetAt: "2026-09-09T12:00:00Z" }) },
      }),
    );

    const error = await graphql(
      "t0ken",
      "query Q { x }",
      {},
      { ...options(stub.fetch), floor: 100 },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RateLimitExhausted);
    expect(error).toMatchObject({ remaining: 40, resetAt: "2026-09-09T12:00:00Z" });
  });

  it("returns a response sitting exactly on the floor", async () => {
    const stub = stubFetch(() =>
      jsonResponse({ data: { rateLimit: rateLimit({ remaining: 100 }) } }),
    );

    const response = await graphql(
      "t0ken",
      "query Q { x }",
      {},
      { ...options(stub.fetch), floor: 100 },
    );

    expect(response.rateLimit.remaining).toBe(100);
  });

  it("rejects a response that selected no rate limit", async () => {
    const stub = stubFetch(() => jsonResponse({ data: { search: {} } }));

    await expect(graphql("t0ken", "query Q { x }", {}, options(stub.fetch))).rejects.toThrow(
      ResponseValidationError,
    );
  });

  it("keeps the body reachable when a 200 carries no JSON at all", async () => {
    const stub = stubFetch(() => new Response("<html>maintenance</html>", { status: 200 }));

    const error = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ResponseValidationError);
    expect(error).toMatchObject({ body: "<html>maintenance</html>" });
  });

  it("keeps the body reachable when the schema rejects the response", async () => {
    const body = JSON.stringify({ data: { rateLimit: { cost: "free" } } });
    const stub = stubFetch(() => new Response(body, { status: 200 }));

    const error = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ResponseValidationError);
    expect(error).toMatchObject({ body });
  });

  it("carries the body and the reported budget out of a partial failure", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        data: { search: {}, rateLimit: rateLimit({ remaining: 4200 }) },
        errors: [{ message: "Something went wrong" }],
      }),
    );

    const error = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphQLQueryError);
    expect(error).toMatchObject({ rateLimit: { remaining: 4200 } });
    expect(error).toHaveProperty("body", expect.stringContaining("Something went wrong"));
  });

  it("carries the body out of a rate limit stop so the page can still be archived", async () => {
    const body = JSON.stringify({ data: { rateLimit: rateLimit({ remaining: 4 }) } });
    const stub = stubFetch(() => new Response(body, { status: 200 }));

    const error = await graphql(
      "t0ken",
      "query Q { x }",
      {},
      { ...options(stub.fetch), floor: 10 },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RateLimitExhausted);
    expect(error).toMatchObject({ body });
  });

  it("names each error class so a caller can branch on it across the RPC boundary", async () => {
    const stub = stubFetch(() => new Response("nope", { status: 500 }));

    const error = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({ name: "GitHubHttpError" });
  });
});
