import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { issue, pullRequest, repository, reviewedPullRequest } from "../../test/github-fixtures";
import {
  issueSearchPage,
  pullRequestSearchPage,
  reviewedPullRequestSearchPage,
  reviewsTruncated,
} from "./schema";

function page(nodes: unknown[], pageInfo: unknown) {
  return { search: { issueCount: nodes.length, pageInfo, nodes } };
}

describe("pageInfo", () => {
  it("accepts a last page", () => {
    const parsed = pullRequestSearchPage.parse(page([], { hasNextPage: false }));

    expect(parsed.search.pageInfo).toEqual({ hasNextPage: false });
  });

  it("accepts a successor paired with its cursor", () => {
    const parsed = pullRequestSearchPage.parse(page([], { hasNextPage: true, endCursor: "Y3Vy" }));

    expect(parsed.search.pageInfo).toEqual({ hasNextPage: true, endCursor: "Y3Vy" });
  });

  it("rejects a successor announced without a cursor", () => {
    expect(() => pullRequestSearchPage.parse(page([], { hasNextPage: true }))).toThrow(ZodError);
  });

  it("rejects a null cursor on a successor", () => {
    expect(() =>
      pullRequestSearchPage.parse(page([], { hasNextPage: true, endCursor: null })),
    ).toThrow(ZodError);
  });
});

describe("search nodes", () => {
  it("parses a pull request node", () => {
    const parsed = pullRequestSearchPage.parse(page([pullRequest(7)], { hasNextPage: false }));

    expect(parsed.search.nodes).toHaveLength(1);
    expect(parsed.search.nodes[0]).toMatchObject({
      id: "PR_7",
      number: 7,
      state: "MERGED",
      additions: 10,
      comments: { totalCount: 1 },
      reviews: { totalCount: 2 },
      repository: { owner: { login: "bendrucker" }, visibility: "PUBLIC" },
    });
  });

  it("parses the reviews off a reviewed-by match", () => {
    const parsed = reviewedPullRequestSearchPage.parse(
      page([reviewedPullRequest(7)], { hasNextPage: false }),
    );

    expect(parsed.search.nodes[0]?.reviews.nodes).toEqual([
      { id: "PRR_7", state: "APPROVED", submittedAt: "2026-08-03T00:00:00Z" },
    ]);
    expect(parsed.search.nodes[0]?.author).toEqual({ login: "someone" });
  });

  it("leaves a pull request whose reviews all fit unflagged", () => {
    const parsed = reviewedPullRequestSearchPage.parse(
      page([reviewedPullRequest(7)], { hasNextPage: false }),
    );

    expect(reviewsTruncated(parsed.search.nodes[0]!)).toBe(false);
  });

  it("flags a pull request carrying more reviews than the page returned", () => {
    const node = reviewedPullRequest(7);
    const parsed = reviewedPullRequestSearchPage.parse(
      page([{ ...node, reviews: { ...node.reviews, totalCount: 120 } }], { hasNextPage: false }),
    );

    expect(reviewsTruncated(parsed.search.nodes[0]!)).toBe(true);
  });

  it("parses an issue node", () => {
    const parsed = issueSearchPage.parse(page([issue(9)], { hasNextPage: false }));

    expect(parsed.search.nodes[0]).toMatchObject({ id: "I_9", state: "OPEN", closedAt: null });
  });

  it("drops a node of another type before checking the shape", () => {
    const parsed = pullRequestSearchPage.parse(
      page([issue(9), pullRequest(7)], { hasNextPage: false }),
    );

    expect(parsed.search.nodes.map((node) => node.id)).toEqual(["PR_7"]);
  });

  it("collapses a null nodes list", () => {
    const parsed = pullRequestSearchPage.parse({
      search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: null },
    });

    expect(parsed.search.nodes).toEqual([]);
  });

  it("rejects a node missing a field the query selected", () => {
    const { additions: _additions, ...incomplete } = pullRequest(7);

    expect(() => pullRequestSearchPage.parse(page([incomplete], { hasNextPage: false }))).toThrow(
      ZodError,
    );
  });

  it("rejects a repository missing its node id", () => {
    const { id: _id, ...incomplete } = repository();

    expect(() =>
      pullRequestSearchPage.parse(
        page([{ ...pullRequest(7), repository: incomplete }], { hasNextPage: false }),
      ),
    ).toThrow(ZodError);
  });
});
