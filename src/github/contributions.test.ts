import { describe, expect, it } from "vitest";
import { stubFetch } from "../../test/fetch-stub";
import {
  contributionsCollection,
  contributionsResponse,
  jsonResponse,
  requestBody,
  TRUNCATED_COMMIT_TOTAL,
} from "../../test/github-fixtures";
import archived2014Q3 from "../../test/fixtures/contributions/2014-Q3.json";
import archived2015Q3 from "../../test/fixtures/contributions/2015-Q3.json";
import archived2026 from "../../test/fixtures/contributions/2026.json";
import archived2026Q3 from "../../test/fixtures/contributions/2026-Q3.json";
import { contributionsResponse as contributionsSchema } from "./schema";
import {
  fetchContributions,
  contributionsTruncated,
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
      totalCommitContributions: 12,
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

  it("flags a year whose day list came back short", async () => {
    const stub = stubFetch(() => contributionsResponse(2, TRUNCATED_COMMIT_TOTAL));

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

// Cut from archived bodies and trimmed to a few repositories. Where trimming
// would itself read as a dropped repository, the totals were rewritten to match
// what was kept.
function archived(body: { data: unknown }) {
  const { user } = contributionsSchema.parse(body.data);
  if (user === null) {
    throw new Error("the fixture carries no user");
  }
  return user.contributionsCollection;
}

describe("contributionsTruncated", () => {
  it("flags a quarter listing fewer repositories than it reports", () => {
    expect(contributionsTruncated(archived(archived2015Q3))).toBe(true);
  });

  it("flags a year whose busiest repositories listed fewer commits than they report", () => {
    expect(contributionsTruncated(archived(archived2026))).toBe(true);
  });

  it("leaves a quarter whose repositories report over 100 commits each unflagged", () => {
    expect(contributionsTruncated(archived(archived2026Q3))).toBe(false);
    expect(contributionsTruncated(archived(archived2014Q3))).toBe(false);
  });

  it("leaves a collection listing exactly the repository maximum unflagged", () => {
    expect(contributionsTruncated(contributionsCollection(100))).toBe(false);
  });

  it("flags commits the collection reports that no listed repository accounts for", () => {
    const collection = contributionsCollection(2);

    expect(
      contributionsTruncated({
        ...collection,
        totalCommitContributions: collection.totalCommitContributions + 1,
      }),
    ).toBe(true);
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
