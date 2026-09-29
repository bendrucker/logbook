import { describe, expect, it } from "vitest";
import { jsonResponse, rateLimit, requestBody } from "../../test/github-fixtures";
import { stubFetch } from "../../test/fetch-stub";
import {
  graphql,
  GitHubHttpError,
  GraphQLQueryError,
  type RequestBudget,
  ResponseValidationError,
  SecondaryRateLimited,
  type GraphQLOptions,
} from "./client";
import type { RateLimit } from "./schema";

const ENDPOINT = "https://api.github.test/graphql";

function options(fetch: typeof globalThis.fetch): GraphQLOptions {
  return { fetch, endpoint: ENDPOINT };
}

function recordingBudget(refusal?: Error) {
  const admitted: number[] = [];
  const readings: RateLimit[] = [];
  const budget: RequestBudget = {
    admit: () => {
      if (refusal !== undefined) {
        return Promise.reject(refusal);
      }
      admitted.push(admitted.length + 1);
      return Promise.resolve();
    },
    spend: (reading) => {
      readings.push(reading);
    },
  };
  return { budget, admitted, readings };
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

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(GitHubHttpError);
    expect(thrown).toMatchObject({ status: 401, body: "bad credentials" });
  });

  it("throws on GraphQL errors even under a 200", async () => {
    const stub = stubFetch(() =>
      jsonResponse({ data: null, errors: [{ message: "Field 'nope' doesn't exist" }] }),
    );

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(GraphQLQueryError);
    expect(thrown).toMatchObject({ errors: [{ message: "Field 'nope' doesn't exist" }] });
  });

  it("throws the typed error when a request-level failure omits data entirely", async () => {
    const stub = stubFetch(() => jsonResponse({ errors: [{ message: "Query has node limit" }] }));

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(GraphQLQueryError);
    expect(thrown).toMatchObject({ errors: [{ message: "Query has node limit" }] });
  });

  it("asks the budget before sending and tells it what the response cost", async () => {
    const stub = stubFetch(() =>
      jsonResponse({ data: { rateLimit: rateLimit({ cost: 1, remaining: 3000 }) } }),
    );
    const { budget, admitted, readings } = recordingBudget();

    await graphql("t0ken", "query Q { x }", {}, { ...options(stub.fetch), budget });

    expect(admitted).toEqual([1]);
    expect(readings).toEqual([rateLimit({ cost: 1, remaining: 3000 })]);
  });

  it("sends nothing the budget refuses", async () => {
    const stub = stubFetch(() => jsonResponse({ data: { rateLimit: rateLimit() } }));
    const refusal = new Error("over budget");
    const { budget } = recordingBudget(refusal);

    const thrown = await graphql(
      "t0ken",
      "query Q { x }",
      {},
      {
        ...options(stub.fetch),
        budget,
      },
    ).catch((error: unknown) => error);

    expect(thrown).toBe(refusal);
    expect(stub.requests).toHaveLength(0);
  });

  it("charges the budget for a partial failure that reports its cost", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        data: { search: {}, rateLimit: rateLimit({ remaining: 4200 }) },
        errors: [{ message: "Something went wrong" }],
      }),
    );
    const { budget, readings } = recordingBudget();

    await graphql("t0ken", "query Q { x }", {}, { ...options(stub.fetch), budget }).catch(
      () => null,
    );

    expect(readings).toEqual([rateLimit({ remaining: 4200 })]);
  });

  it("reads a 403 carrying retry-after as a secondary limit", async () => {
    const body = JSON.stringify({ message: "You have exceeded a secondary rate limit." });
    const stub = stubFetch(
      () => new Response(body, { status: 403, headers: { "Retry-After": "120" } }),
    );

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(SecondaryRateLimited);
    expect(thrown).toMatchObject({
      name: "SecondaryRateLimited",
      status: 403,
      retryAfterSeconds: 120,
      body,
    });
  });

  it("waits a minute on a secondary limit that names no wait", async () => {
    const stub = stubFetch(
      () => new Response("You have exceeded a secondary rate limit", { status: 429 }),
    );

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toMatchObject({ name: "SecondaryRateLimited", retryAfterSeconds: 60 });
  });

  it("keeps a 403 that names no limit a plain HTTP failure", async () => {
    const stub = stubFetch(() => new Response("Resource not accessible", { status: 403 }));

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(GitHubHttpError);
    expect(thrown).not.toBeInstanceOf(SecondaryRateLimited);
  });

  it("rejects a response that selected no rate limit", async () => {
    const stub = stubFetch(() => jsonResponse({ data: { search: {} } }));

    await expect(graphql("t0ken", "query Q { x }", {}, options(stub.fetch))).rejects.toThrow(
      ResponseValidationError,
    );
  });

  it("keeps the body reachable when a 200 carries no JSON at all", async () => {
    const stub = stubFetch(() => new Response("<html>maintenance</html>", { status: 200 }));

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ResponseValidationError);
    expect(thrown).toMatchObject({ body: "<html>maintenance</html>" });
  });

  it("keeps the body reachable when the schema rejects the response", async () => {
    const body = JSON.stringify({ data: { rateLimit: { cost: "free" } } });
    const stub = stubFetch(() => new Response(body, { status: 200 }));

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ResponseValidationError);
    expect(thrown).toMatchObject({ body });
  });

  it("carries the body and the reported budget out of a partial failure", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        data: { search: {}, rateLimit: rateLimit({ remaining: 4200 }) },
        errors: [{ message: "Something went wrong" }],
      }),
    );

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(GraphQLQueryError);
    expect(thrown).toMatchObject({ rateLimit: { remaining: 4200 } });
    expect(thrown).toHaveProperty("body", expect.stringContaining("Something went wrong"));
  });

  it("names each error class so a caller can branch on it across the RPC boundary", async () => {
    const stub = stubFetch(() => new Response("nope", { status: 500 }));

    const thrown = await graphql("t0ken", "query Q { x }", {}, options(stub.fetch)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toMatchObject({ name: "GitHubHttpError" });
  });
});
