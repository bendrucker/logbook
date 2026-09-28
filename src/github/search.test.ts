import { describe, expect, it } from "vitest";
import { stubFetch, type FetchStub } from "../../test/fetch-stub";
import {
  pullRequest,
  rateLimit,
  requestBody,
  review,
  reviewedPullRequest,
  reviewsPayload,
  jsonResponse,
  searchResponse,
} from "../../test/github-fixtures";
import { type RequestBudget, ResponseValidationError } from "./client";
import { RepeatedCursorError } from "./pages";
import { type PullRequestNode } from "./schema";
import {
  pullRequestPages,
  reviewedPullRequestPages,
  SEARCH_MAX_RESULTS,
  SEARCH_PAGE_SIZE,
  type SearchPageResult,
} from "./search";

const ENDPOINT = "https://api.github.test/graphql";

function pages(stub: FetchStub, budget?: RequestBudget) {
  return pullRequestPages({
    token: "t0ken",
    searchQuery: "is:pr author:bendrucker created:2026-08-01..2026-08-31",
    fetch: stub.fetch,
    endpoint: ENDPOINT,
    budget,
  });
}

async function collect<T>(
  iterator: AsyncGenerator<SearchPageResult<T>>,
): Promise<SearchPageResult<T>[]> {
  const results: SearchPageResult<T>[] = [];
  for await (const result of iterator) {
    results.push(result);
  }
  return results;
}

describe("searchPages", () => {
  it("follows the cursor across two pages", async () => {
    let served = 0;
    const stub = stubFetch(() => {
      served += 1;
      return served === 1
        ? searchResponse([pullRequest(1)], { issueCount: 2, endCursor: "Y3Vy" })
        : searchResponse([pullRequest(2)], { issueCount: 2 });
    });

    const results = await collect(pages(stub));

    expect(results.map((result) => result.page)).toEqual([1, 2]);
    expect(results.flatMap((result) => result.nodes.map((node) => node.id))).toEqual([
      "PR_1",
      "PR_2",
    ]);
  });

  it("sends the cursor the previous page returned", async () => {
    let served = 0;
    const stub = stubFetch(() => {
      served += 1;
      return served === 1
        ? searchResponse([pullRequest(1)], { endCursor: "Y3Vy" })
        : searchResponse([pullRequest(2)]);
    });

    await collect(pages(stub));

    const [first, second] = stub.requests;
    await expect(requestBody(first!)).resolves.toMatchObject({
      variables: {
        after: null,
        first: 100,
        searchQuery: "is:pr author:bendrucker created:2026-08-01..2026-08-31",
      },
    });
    await expect(requestBody(second!)).resolves.toMatchObject({ variables: { after: "Y3Vy" } });
  });

  it("stops on a page that announces no successor", async () => {
    const stub = stubFetch(() => searchResponse([pullRequest(1)]));

    await collect(pages(stub));

    expect(stub.requests).toHaveLength(1);
  });

  it("returns the raw body alongside the parsed nodes", async () => {
    const stub = stubFetch(() => searchResponse([pullRequest(1)]));

    const [result] = await collect(pages(stub));

    expect(JSON.parse(result!.body)).toMatchObject({ data: { rateLimit: rateLimit() } });
  });

  it("leaves a window matching exactly the cap unflagged", async () => {
    const stub = stubFetch(() => searchResponse([pullRequest(1)], { issueCount: 1000 }));

    const [result] = await collect(pages(stub));

    expect(result?.truncated).toBe(false);
    expect(result?.issueCount).toBe(1000);
  });

  it("flags a window matching more than the cap", async () => {
    const stub = stubFetch(() => searchResponse([pullRequest(1)], { issueCount: 1001 }));

    const [result] = await collect(pages(stub));

    expect(result?.truncated).toBe(true);
  });

  it("stops after one page when the cursor repeats", async () => {
    const stub = stubFetch(() => searchResponse([pullRequest(1)], { endCursor: "Y3Vy" }));

    const results: SearchPageResult<PullRequestNode>[] = [];
    const error = await (async () => {
      for await (const result of pages(stub)) {
        results.push(result);
      }
    })().catch((thrown: unknown) => thrown);

    expect(results.map((result) => result.page)).toEqual([1]);
    expect(stub.requests).toHaveLength(2);
    expect(error).toBeInstanceOf(RepeatedCursorError);
    expect(error).toMatchObject({ cursor: "Y3Vy" });
  });

  it("stops paging when the budget refuses the next request", async () => {
    const stub = stubFetch(() => searchResponse([pullRequest(1)], { endCursor: "Y3Vy" }));
    const refusal = new Error("over budget");
    let admitted = 0;
    const budget: RequestBudget = {
      admit: async () => {
        admitted += 1;
        if (admitted > 1) {
          throw refusal;
        }
      },
      spend: () => {},
    };

    const iterator = pages(stub, budget);

    const first = await iterator.next();
    expect(first.value?.page).toBe(1);

    const error = await iterator.next().catch((thrown: unknown) => thrown);
    expect(error).toBe(refusal);
    expect(stub.requests).toHaveLength(1);
  });
});

describe("search entry points", () => {
  it("sends the login the reviewed-by document declares", async () => {
    const stub = stubFetch(() => searchResponse([]));

    const iterator = reviewedPullRequestPages({
      token: "t0ken",
      searchQuery: "is:pr reviewed-by:bendrucker created:2026-08-01..2026-08-31",
      login: "bendrucker",
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });
    await iterator.next();

    await expect(requestBody(stub.requests[0]!)).resolves.toMatchObject({
      variables: { login: "bendrucker" },
    });
  });

  it("flags a reviewed pull request whose reviews outran their page", async () => {
    const stub = stubFetch(() =>
      searchResponse([reviewedPullRequest(7, { reviews: { totalCount: 2, nodes: [review(7)] } })]),
    );

    const iterator = reviewedPullRequestPages({
      token: "t0ken",
      searchQuery: "is:pr reviewed-by:bendrucker created:2026-08-01..2026-08-31",
      login: "bendrucker",
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });
    const first = await iterator.next();

    expect(first.value?.truncated).toBe(true);
  });

  it("reads a pull request's reviews past its nested page", async () => {
    const node = reviewedPullRequest(7, {
      reviews: {
        totalCount: 2,
        pageInfo: { hasNextPage: true, endCursor: "cmV2" },
        nodes: [review(7)],
      },
    });
    let served = 0;
    const stub = stubFetch(() => {
      served += 1;
      return served === 1
        ? searchResponse([node])
        : jsonResponse(reviewsPayload([review(8)], { totalCount: 2 }));
    });

    const iterator = reviewedPullRequestPages({
      token: "t0ken",
      searchQuery: "is:pr reviewed-by:bendrucker created:2026-08-01..2026-08-31",
      login: "bendrucker",
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });
    const [page] = await collect(iterator);

    await expect(requestBody(stub.requests[1]!)).resolves.toMatchObject({
      variables: { id: "PR_7", login: "bendrucker", after: "cmV2" },
    });
    expect(page?.truncated).toBe(false);
    expect(page?.nodes[0]?.reviews.nodes.map((each) => each.id)).toEqual(["PRR_7", "PRR_8"]);
    expect(page?.reviewPages).toMatchObject([{ pullRequest: "PR_7", page: 1 }]);
  });

  it("yields a page whose follow-up failed before throwing the failure", async () => {
    const outran = (id: number) =>
      reviewedPullRequest(id, {
        reviews: {
          totalCount: 2,
          pageInfo: { hasNextPage: true, endCursor: `cmV2-${id}` },
          nodes: [review(id)],
        },
      });
    const failure = { errors: [{ message: "Something went wrong" }], data: null };
    let served = 0;
    const stub = stubFetch(() => {
      served += 1;
      if (served === 1) {
        return searchResponse([outran(7), outran(9)]);
      }
      return served === 2
        ? jsonResponse(reviewsPayload([review(8)], { totalCount: 2 }))
        : jsonResponse(failure);
    });

    const iterator = reviewedPullRequestPages({
      token: "t0ken",
      searchQuery: "is:pr reviewed-by:bendrucker created:2026-08-01..2026-08-31",
      login: "bendrucker",
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });
    const first = await iterator.next();
    const page = first.done === true ? undefined : first.value;

    expect(page?.nodes.map((node) => node.reviews.nodes.map((each) => each.id))).toEqual([
      ["PRR_7", "PRR_8"],
      ["PRR_9"],
    ]);
    expect(page?.reviewPages).toMatchObject([{ pullRequest: "PR_7", page: 1 }]);
    expect(page?.failure).toMatchObject({ pullRequest: "PR_9", page: 1 });
    expect(page?.truncated).toBe(true);

    const error = await iterator.next().catch((thrown: unknown) => thrown);
    expect(error).toBe(page?.failure?.error);
    expect(stub.requests).toHaveLength(3);
  });

  it("fails a follow-up that echoes the cursor it started from", async () => {
    const node = reviewedPullRequest(7, {
      reviews: {
        totalCount: 3,
        pageInfo: { hasNextPage: true, endCursor: "cmV2" },
        nodes: [review(7)],
      },
    });
    let served = 0;
    const stub = stubFetch(() => {
      served += 1;
      return served === 1
        ? searchResponse([node])
        : jsonResponse(reviewsPayload([review(8)], { totalCount: 3, endCursor: "cmV2" }));
    });

    const iterator = reviewedPullRequestPages({
      token: "t0ken",
      searchQuery: "is:pr reviewed-by:bendrucker created:2026-08-01..2026-08-31",
      login: "bendrucker",
      fetch: stub.fetch,
      endpoint: ENDPOINT,
    });
    const first = await iterator.next();

    expect(first.value?.reviewPages).toEqual([]);
    expect(first.value?.failure?.error).toBeInstanceOf(RepeatedCursorError);
    expect(first.value?.failure?.error).toMatchObject({ cursor: "cmV2" });
    await expect(iterator.next()).rejects.toBeInstanceOf(RepeatedCursorError);
    expect(stub.requests).toHaveLength(2);
  });

  it("stops at the result cap rather than following a cursor GitHub will reject", async () => {
    let served = 0;
    const stub = stubFetch(() => {
      served += 1;
      return searchResponse([pullRequest(served)], {
        issueCount: SEARCH_MAX_RESULTS + 1,
        endCursor: `cursor-${served}`,
      });
    });

    const results = await collect(pages(stub));

    expect(results).toHaveLength(SEARCH_MAX_RESULTS / SEARCH_PAGE_SIZE);
    expect(results.at(-1)?.truncated).toBe(true);
  });

  it("keeps the raw body reachable when the page fails to validate", async () => {
    const body = JSON.stringify({
      data: {
        search: { issueCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ __typename: 42 }] },
        rateLimit: rateLimit(),
      },
    });
    const stub = stubFetch(() => new Response(body, { status: 200 }));

    const error = await collect(pages(stub)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ResponseValidationError);
    expect(error).toMatchObject({ body });
  });
});
