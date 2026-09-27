import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { stubFetch } from "../../test/fetch-stub";
import {
  contributionsPayload,
  jsonResponse,
  requestBody,
  searchPayload,
} from "../../test/github-fixtures";
import { backfill, InvalidMonthError, parseMonth } from "./backfill";
import { readWatermark } from "./state";

// Far enough past the 2012-12 start that a single call cannot reach it, so the
// resume point is a real month rather than the end of the walk.
const NOW = new Date("2014-06-15T00:00:00.000Z");

beforeEach(async () => {
  env.GITHUB_TOKEN = "token";
  const listed = await env.RAW.list();
  await env.RAW.delete(listed.objects.map((object) => object.key));
});

function stubGitHub(reply: () => Response) {
  const queries: unknown[] = [];
  const { fetch, requests } = stubFetch(async (request) => {
    const { variables } = await requestBody(request.clone());
    queries.push(variables.searchQuery);
    return reply();
  });

  return { fetch, requests, queries };
}

describe("parseMonth", () => {
  it("reads a YYYY-MM month", () => {
    expect(parseMonth("2012-12")).toEqual({ year: 2012, month: 12 });
  });

  it.each(["2012", "2012-13", "2012-00", "december", "2012-1"])("rejects %s", (value) => {
    expect(() => parseMonth(value)).toThrow(InvalidMonthError);
  });
});

describe("backfill", () => {
  it("walks a call's worth of months and reports where the next call resumes", async () => {
    const { fetch, queries } = stubGitHub(() => jsonResponse(searchPayload([])));

    const result = await backfill(
      env,
      "pr-authored",
      { year: 2012, month: 12 },
      { fetch, now: NOW },
    );

    expect(result.windows).toHaveLength(env.BACKFILL_WINDOWS);
    expect(result.windows.at(0)).toBe("2012-12");
    expect(result.windows.at(-1)).toBe("2013-11");
    expect(result.next).toBe("2013-12");
    expect(queries.at(0)).toBe("is:pr author:bendrucker created:2012-12-01..2012-12-31");
    expect(queries.at(-1)).toBe("is:pr author:bendrucker created:2013-11-01..2013-11-30");
  });

  it("resumes on the window that failed", async () => {
    const { fetch, requests } = stubGitHub(() => jsonResponse({ errors: [{ message: "boom" }] }));

    const result = await backfill(env, "issue", { year: 2012, month: 12 }, { fetch, now: NOW });

    expect(requests).toHaveLength(1);
    expect(result.next).toBe("2012-12");
    expect(result.error).toContain("GraphQLQueryError");
  });

  it("ends the walk when the months run out", async () => {
    const { fetch } = stubGitHub(() => jsonResponse(searchPayload([])));

    const result = await backfill(env, "issue", { year: 2014, month: 1 }, { fetch, now: NOW });

    expect(result.windows).toEqual([
      "2014-01",
      "2014-02",
      "2014-03",
      "2014-04",
      "2014-05",
      "2014-06",
    ]);
    expect(result.next).toBeNull();
  });

  it("leaves the in-progress month's watermark at the present, not at the month's end", async () => {
    const { fetch } = stubGitHub(() => jsonResponse(searchPayload([])));

    await backfill(env, "issue", { year: 2014, month: 6 }, { fetch, now: NOW });

    // 2014-06-30 has not happened yet. A watermark there outranks every later
    // advance the monotonic guard sees, so the hourly sync would go quiet for
    // the rest of the month.
    expect(await readWatermark(env.DB, "issue")).toMatchObject({
      window: NOW.toISOString(),
    });
  });

  it("walks the years the collection reports rather than a range of its own", async () => {
    const { fetch, requests } = stubGitHub(() =>
      jsonResponse(contributionsPayload(1, undefined, { contributionYears: [2014, 2013, 2012] })),
    );

    const result = await backfill(
      env,
      "contributions",
      { year: 2012, month: 1 },
      { fetch, now: NOW },
    );

    expect(requests).toHaveLength(3);
    expect(result.windows).toEqual(["2012", "2013", "2014"]);
    expect(result.next).toBeNull();
  });
});
