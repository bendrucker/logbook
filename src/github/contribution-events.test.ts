import { describe, expect, it } from "vitest";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import {
  contributionEventsPayload,
  issue,
  jsonResponse,
  pullRequest,
  requestBody,
  review,
  reviewedPullRequest,
} from "../../test/github-fixtures";
import { contributionsWindow } from "./calendar";
import {
  CONTRIBUTION_EVENTS_MAX_PAGES,
  type ContributionEventsPageResult,
  issueContributionPages,
  pullRequestContributionPages,
  reviewContributionPages,
} from "./contribution-events";
import { UnknownUserError } from "./contributions";
import { RepeatedCursorError } from "./pages";

const ENDPOINT = "https://api.github.test/graphql";
const NOW = new Date("2026-09-09T12:00:00Z");

function options(stub: FetchStub) {
  return {
    token: "t0ken",
    login: "bendrucker",
    window: contributionsWindow("2015", NOW),
    fetch: stub.fetch,
    endpoint: ENDPOINT,
  };
}

function staged(bodies: readonly unknown[]): FetchStub {
  const queue = [...bodies];
  return stubFetch(() => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("the pager asked for more pages than the test staged");
    }
    return jsonResponse(next);
  });
}

async function collect<T>(
  pages: AsyncGenerator<ContributionEventsPageResult<T>>,
): Promise<ContributionEventsPageResult<T>[]> {
  const results: ContributionEventsPageResult<T>[] = [];
  for await (const page of pages) {
    results.push(page);
  }
  return results;
}

describe("issueContributionPages", () => {
  it("follows the cursor and unwraps each issue from its contribution", async () => {
    const stub = staged([
      contributionEventsPayload("issueContributions", [issue(1), issue(2)], {
        totalCount: 3,
        endCursor: "Y3Vy",
      }),
      contributionEventsPayload("issueContributions", [issue(3)], { totalCount: 3 }),
    ]);

    const pages = await collect(issueContributionPages(options(stub)));

    expect(pages.map((page) => page.nodes.map((node) => node.id))).toEqual([
      ["I_1", "I_2"],
      ["I_3"],
    ]);
    expect(pages.map((page) => page.truncated)).toEqual([false, false]);
    await expect(requestBody(stub.requests[1]!)).resolves.toMatchObject({
      variables: {
        login: "bendrucker",
        from: "2015-01-01T00:00:00.000Z",
        to: "2015-12-31T23:59:59.000Z",
        first: 100,
        after: "Y3Vy",
      },
    });
  });

  it("flags a connection whose cursor ended short of its count", async () => {
    const stub = staged([
      contributionEventsPayload("issueContributions", [issue(1)], { totalCount: 2 }),
    ]);

    const [page] = await collect(issueContributionPages(options(stub)));

    expect(page?.truncated).toBe(true);
  });

  it("stops at the page bound and flags the window for splitting", async () => {
    const stub = stubFetch((request) =>
      requestBody(request.clone()).then(({ variables }) =>
        jsonResponse(
          contributionEventsPayload("issueContributions", [issue(1)], {
            totalCount: 50,
            endCursor: `cursor-${String(variables.after)}`,
          }),
        ),
      ),
    );

    const pages = await collect(issueContributionPages(options(stub)));

    expect(pages).toHaveLength(CONTRIBUTION_EVENTS_MAX_PAGES);
    expect(pages.at(-1)?.truncated).toBe(true);
    expect(pages.slice(0, -1).every((page) => !page.truncated)).toBe(true);
  });

  it("stops after one page when the cursor repeats", async () => {
    const stub = stubFetch(() =>
      jsonResponse(
        contributionEventsPayload("issueContributions", [issue(1)], {
          totalCount: 5,
          endCursor: "Y3Vy",
        }),
      ),
    );

    const pages: ContributionEventsPageResult<unknown>[] = [];
    const error = await (async () => {
      for await (const page of issueContributionPages(options(stub))) {
        pages.push(page);
      }
    })().catch((thrown: unknown) => thrown);

    expect(pages).toHaveLength(1);
    expect(error).toBeInstanceOf(RepeatedCursorError);
  });

  it("throws for a login GitHub does not know", async () => {
    const stub = staged([
      { data: { user: null, rateLimit: { cost: 1, remaining: 1, resetAt: "" } } },
    ]);

    await expect(collect(issueContributionPages(options(stub)))).rejects.toBeInstanceOf(
      UnknownUserError,
    );
  });
});

describe("pullRequestContributionPages", () => {
  it("unwraps each pull request from its contribution", async () => {
    const stub = staged([contributionEventsPayload("pullRequestContributions", [pullRequest(4)])]);

    const [page] = await collect(pullRequestContributionPages(options(stub)));

    expect(page?.nodes).toEqual([pullRequest(4)]);
    expect(page?.truncated).toBe(false);
  });
});

describe("reviewContributionPages", () => {
  it("sends the login the nested reviews filter on", async () => {
    const stub = staged([
      contributionEventsPayload("pullRequestReviewContributions", [reviewedPullRequest(5)]),
    ]);

    const [page] = await collect(reviewContributionPages(options(stub)));

    expect(page?.nodes).toEqual([reviewedPullRequest(5)]);
    const { query } = await requestBody(stub.requests[0]!);
    expect(query).toContain("reviews(author: $login, first: 100)");
  });

  it("flags a pull request whose reviews overflowed the nested page", async () => {
    const stub = staged([
      contributionEventsPayload("pullRequestReviewContributions", [
        reviewedPullRequest(5, { reviews: { totalCount: 2, nodes: [review(5)] } }),
      ]),
    ]);

    const [page] = await collect(reviewContributionPages(options(stub)));

    expect(page?.truncated).toBe(true);
  });
});
