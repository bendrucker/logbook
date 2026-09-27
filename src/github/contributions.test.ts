import { describe, expect, it } from "vitest";
import { stubFetch } from "../../test/fetch-stub";
import { contributionsResponse, jsonResponse, requestBody } from "../../test/github-fixtures";
import {
  fetchContributions,
  MAX_REPOSITORIES,
  quarterWindows,
  UnknownUserError,
  yearWindow,
} from "./contributions";

const ENDPOINT = "https://api.github.test/graphql";
const NOW = new Date("2026-09-09T12:00:00Z");

describe("fetchContributions", () => {
  it("returns the collection and its totals", async () => {
    const stub = stubFetch(() => contributionsResponse(3));

    const result = await fetchContributions("t0ken", "bendrucker", yearWindow(2025, NOW), {
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });

    expect(result.window.key).toBe("2025");
    expect(result.collection).toMatchObject({
      totalCommitContributions: 120,
      totalPullRequestReviewContributions: 12,
      restrictedContributionsCount: 0,
      contributionYears: [2026, 2025],
    });
    expect(result.collection.commitContributionsByRepository).toHaveLength(3);
    expect(result.collection.commitContributionsByRepository[0]?.contributions.nodes).toEqual([
      { commitCount: 4, occurredAt: "2026-08-02T00:00:00Z" },
    ]);
  });

  it("asks for the whole of a past year", async () => {
    const stub = stubFetch(() => contributionsResponse(1));

    await fetchContributions("t0ken", "bendrucker", yearWindow(2025, NOW), {
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });

    await expect(requestBody(stub.requests[0]!)).resolves.toMatchObject({
      variables: {
        login: "bendrucker",
        from: "2025-01-01T00:00:00.000Z",
        to: "2025-12-31T23:59:59.000Z",
      },
    });
  });

  it("stops the current year at now, since a window wider than a year is rejected", async () => {
    const stub = stubFetch(() => contributionsResponse(1));

    await fetchContributions("t0ken", "bendrucker", yearWindow(2026, NOW), {
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });

    await expect(requestBody(stub.requests[0]!)).resolves.toMatchObject({
      variables: { from: "2026-01-01T00:00:00.000Z", to: "2026-09-09T12:00:00.000Z" },
    });
  });

  it("leaves a year under the repository maximum unflagged", async () => {
    const stub = stubFetch(() => contributionsResponse(MAX_REPOSITORIES - 1));

    const result = await fetchContributions("t0ken", "bendrucker", yearWindow(2025, NOW), {
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });

    expect(result.truncated).toBe(false);
  });

  it("flags a year that came back on the repository maximum", async () => {
    const stub = stubFetch(() => contributionsResponse(MAX_REPOSITORIES));

    const result = await fetchContributions("t0ken", "bendrucker", yearWindow(2025, NOW), {
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });

    expect(result.truncated).toBe(true);
    expect(result.collection.totalRepositoriesWithContributedCommits).toBe(MAX_REPOSITORIES);
  });

  it("flags a repository whose daily contributions did not all fit on the page", async () => {
    const stub = stubFetch(() => contributionsResponse(2, 400));

    const result = await fetchContributions("t0ken", "bendrucker", yearWindow(2025, NOW), {
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });

    expect(result.truncated).toBe(true);
  });

  it("returns the raw body alongside the parsed collection", async () => {
    const stub = stubFetch(() => contributionsResponse(1));

    const result = await fetchContributions("t0ken", "bendrucker", yearWindow(2025, NOW), {
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });

    expect(JSON.parse(result.body)).toMatchObject({ data: { user: {} } });
  });

  it("throws when the login matches no user", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        data: {
          user: null,
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-09T11:00:00Z" },
        },
      }),
    );

    await expect(
      fetchContributions("t0ken", "nobody", yearWindow(2025, NOW), {
        fetch: stub.fetch,
        endpoint: ENDPOINT,
      }),
    ).rejects.toThrow(UnknownUserError);
  });
});

describe("quarterWindows", () => {
  function bounds(year: number) {
    return quarterWindows(year, NOW).map(({ key, from, to }) => ({
      key,
      from: from.toISOString(),
      to: to.toISOString(),
    }));
  }

  it("splits a past year into four quarters that meet end to end", () => {
    expect(bounds(2025)).toEqual([
      { key: "2025-Q1", from: "2025-01-01T00:00:00.000Z", to: "2025-03-31T23:59:59.000Z" },
      { key: "2025-Q2", from: "2025-04-01T00:00:00.000Z", to: "2025-06-30T23:59:59.000Z" },
      { key: "2025-Q3", from: "2025-07-01T00:00:00.000Z", to: "2025-09-30T23:59:59.000Z" },
      { key: "2025-Q4", from: "2025-10-01T00:00:00.000Z", to: "2025-12-31T23:59:59.000Z" },
    ]);
  });

  it("stops the current year at now and leaves out quarters yet to start", () => {
    expect(bounds(2026).at(-1)).toEqual({
      key: "2026-Q3",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-09-09T12:00:00.000Z",
    });
    expect(bounds(2026)).toHaveLength(3);
  });
});
