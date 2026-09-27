import type { ContributionsCollection } from "../github/schema";

// GitHub's own yearly totals against what the event tables hold. A search
// window that lost rows shows up here and nowhere else. It is recorded rather
// than failed on: `restrictedContributionsCount` counts contributions the token
// cannot see, so a gap can be a visibility difference instead of lost rows.
//
// Each total is compared like with like. GitHub counts a pull request once
// however many reviews it drew, including reviews on the login's own pull
// requests, which the reviews table leaves out. So the review total is set
// against distinct pull requests by the year of their first review, after
// taking off the own ones when the caller has counted them.
export async function crossCheck(
  db: D1Database,
  year: number,
  collection: ContributionsCollection,
  ownReviews?: number,
): Promise<string | null> {
  const stored = await yearTotals(db, year);
  const reported = {
    "pull requests": collection.totalPullRequestContributions,
    reviews: collection.totalPullRequestReviewContributions - (ownReviews ?? 0),
    issues: collection.totalIssueContributions,
    commits: collection.totalCommitContributions,
  };

  const gaps = TOTALS.filter((name) => reported[name] !== stored[name]).map((name) =>
    name === "reviews"
      ? reviewGap(collection.totalPullRequestReviewContributions, ownReviews, stored.reviews)
      : `${name} ${reported[name]} vs ${stored[name]}`,
  );
  if (gaps.length === 0) {
    return null;
  }

  return `${year} totals disagree: ${gaps.join(", ")} (restricted ${collection.restrictedContributionsCount})`;
}

// `reviews 75 (38 own) vs 37 PRs`: GitHub's figure as it reports it, the part
// the table excludes by design, and the distinct pull requests the table holds.
function reviewGap(reported: number, own: number | undefined, stored: number): string {
  const excluded = own === undefined ? "" : ` (${own} own)`;
  return `reviews ${reported}${excluded} vs ${stored} PRs`;
}

const TOTALS = ["pull requests", "reviews", "issues", "commits"] as const;

type Totals = Record<(typeof TOTALS)[number], number>;

const SOURCES: Record<(typeof TOTALS)[number], string> = {
  "pull requests":
    "SELECT COUNT(*) AS total FROM pull_requests WHERE created_at >= ?1 AND created_at < ?2",
  reviews:
    "SELECT COUNT(*) AS total FROM (SELECT MIN(submitted_at) AS first FROM reviews" +
    " GROUP BY repository_id, pull_request_number) WHERE first >= ?1 AND first < ?2",
  issues: "SELECT COUNT(*) AS total FROM issues WHERE created_at >= ?1 AND created_at < ?2",
  commits:
    "SELECT COALESCE(SUM(commit_count), 0) AS total FROM commit_days WHERE day >= ?1 AND day < ?2",
};

async function yearTotals(db: D1Database, year: number): Promise<Totals> {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const results = await db.batch<{ total: number }>(
    TOTALS.map((name) => db.prepare(SOURCES[name]).bind(from, to)),
  );

  // batch answers in the order it was given, so each name reads its own count.
  const counted = (name: (typeof TOTALS)[number]): number =>
    results[TOTALS.indexOf(name)]?.results[0]?.total ?? 0;

  return {
    "pull requests": counted("pull requests"),
    reviews: counted("reviews"),
    issues: counted("issues"),
    commits: counted("commits"),
  };
}
