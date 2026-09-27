import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeClock } from "../../test/clock";
import { stubFetch } from "../../test/fetch-stub";
import {
  contributionEventsPayload,
  issue,
  jsonResponse,
  rateLimit,
  requestBody,
  review,
  reviewedPullRequest,
} from "../../test/github-fixtures";
import { readRow } from "../../test/tables";
import { contributionEventsKey } from "../github/raw";
import { backfill } from "./backfill";
import { recentRuns } from "./runs";
import { readWatermark } from "./state";

const NOW = new Date("2014-06-15T00:00:00.000Z");
const FETCHED_AT = NOW.toISOString();

beforeEach(async () => {
  env.GITHUB_TOKEN = "token";
  const listed = await env.RAW.list();
  await env.RAW.delete(listed.objects.map((object) => object.key));
});

function count(table: string): Promise<{ total: number } | null> {
  return readRow<{ total: number }>(env.DB, `SELECT COUNT(*) AS total FROM ${table}`);
}

function units() {
  return env.DB.prepare("SELECT window, status FROM crawl_units ORDER BY window")
    .all<{ window: string; status: string }>()
    .then(({ results }) => results);
}

describe("contribution connection backfill", () => {
  it("archives each page, writes the reviews, and drops those on the login's own pull requests", async () => {
    const own = reviewedPullRequest(2, {
      author: { login: "BenDrucker" },
      reviews: { totalCount: 1, nodes: [review(2)] },
    });
    const pages = [
      contributionEventsPayload("pullRequestReviewContributions", [reviewedPullRequest(1), own], {
        totalCount: 3,
        endCursor: "Y3Vy",
      }),
      contributionEventsPayload("pullRequestReviewContributions", [reviewedPullRequest(3)], {
        totalCount: 3,
      }),
    ];
    const { fetch } = stubFetch(() => jsonResponse(pages.shift()));

    const result = await backfill(
      env,
      "review-contributions",
      { year: 2014, month: 1 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(result).toMatchObject({ windows: ["2014"], pages: 2, pending: 0, error: null });
    expect(await count("reviews")).toEqual({ total: 2 });
    expect(await readRow(env.DB, "SELECT id FROM reviews WHERE id = ?", "PRR_2")).toBeNull();
    for (const page of [1, 2]) {
      const archived = await env.RAW.head(
        contributionEventsKey("pr-reviewed", "2014", FETCHED_AT, page),
      );
      expect(archived).not.toBeNull();
    }
    expect(await recentRuns(env.DB, "review-contributions", 1)).toMatchObject([
      { window: "2014", pages: 2, truncated: false, error: null },
    ]);
    expect(await readWatermark(env.DB, "pr-reviewed")).toBeNull();
  });

  it("splits a year past the page bound into quarters and lands every issue", async () => {
    const { fetch } = stubFetch(async (request) => {
      const { variables } = await requestBody(request.clone());
      // The year keeps announcing successors, and each quarter answers whole.
      if (variables.from === "2014-01-01T00:00:00.000Z" && variables.to === FETCHED_AT) {
        return jsonResponse(
          contributionEventsPayload("issueContributions", [issue(1)], {
            totalCount: 2000,
            endCursor: `after-${String(variables.after)}`,
          }),
        );
      }
      const number = variables.from === "2014-01-01T00:00:00.000Z" ? 2 : 3;
      return jsonResponse(contributionEventsPayload("issueContributions", [issue(number)]));
    });

    const result = await backfill(
      env,
      "issue-contributions",
      { year: 2014, month: 1 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(result).toMatchObject({
      windows: ["2014", "2014-Q1", "2014-Q2"],
      pages: 12,
      pending: 0,
      irreducible: [],
    });
    expect(await units()).toEqual([
      { window: "2014", status: "split" },
      { window: "2014-Q1", status: "done" },
      { window: "2014-Q2", status: "done" },
    ]);
    expect(await count("issues")).toEqual({ total: 3 });
  });

  it("archives the body that failed validation as the next page", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ data: { user: { contributionsCollection: {} }, rateLimit: rateLimit() } }),
    );

    const result = await backfill(
      env,
      "pr-contributions",
      { year: 2014, month: 1 },
      { fetch, now: NOW, clock: fakeClock().clock },
    );

    expect(result.error).toContain("ResponseValidationError");
    expect(result.pending).toBe(1);
    expect(
      await env.RAW.head(contributionEventsKey("pr-authored", "2014", FETCHED_AT, 1)),
    ).not.toBeNull();
  });
});
