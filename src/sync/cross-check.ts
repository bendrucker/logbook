import type { ContributionsCollection } from "../github/schema";
import type { EventKind } from "../github/windows";
import { authoredBy, readContributionEvents } from "../normalize";

// A note names this many node IDs per side of a gap, then counts the rest.
const NAMED_LIMIT = 10;

// What the year's archived connection pages list: the events GitHub counts,
// read from R2 rather than asked for again. A kind with no untruncated archive
// for the year is absent.
export interface ArchivedYear {
  issues?: ReadonlySet<string>;
  pullRequests?: ReadonlySet<string>;
  // The distinct pull requests reviewed and how many of them are the login's
  // own, which the reviews table leaves out.
  reviews?: { pullRequests: number; own: number };
}

// The connection backfill already fetched these pages, so this check sends no
// request.
export async function archivedYear(
  bucket: R2Bucket,
  year: number,
  login: string,
): Promise<ArchivedYear> {
  // One kind at a time, each reduced to what the check compares before the
  // next is read, so the reads stay within one stream's concurrency and only
  // one kind's nodes are held at once.
  const issues = await archivedNodes(bucket, "issue", year);
  const archived: ArchivedYear = issues === null ? {} : { issues: new Set(issues.keys()) };
  const pullRequests = await archivedNodes(bucket, "pr-authored", year);
  if (pullRequests !== null) {
    archived.pullRequests = new Set(pullRequests.keys());
  }
  const reviewed = await archivedNodes(bucket, "pr-reviewed", year);
  if (reviewed !== null) {
    archived.reviews = {
      pullRequests: reviewed.size,
      own: [...reviewed.values()].filter((node) => authoredBy(node, login)).length,
    };
  }
  return archived;
}

interface Authored {
  id: string;
  author: { login: string } | null;
}

// Every node the kind's archive holds for the year, keyed by node ID, so an
// event two windows both listed counts once. Null when nothing is archived or
// some window dropped events, since a partial list would name gaps that are
// not there.
async function archivedNodes(
  bucket: R2Bucket,
  kind: EventKind,
  year: number,
): Promise<Map<string, Authored> | null> {
  const archived = await readContributionEvents(bucket, kind, String(year));
  if (archived === null || archived.truncated) {
    return null;
  }
  const nodes = new Map<string, Authored>();
  for (const fetch of archived.fetches) {
    const listed: readonly Authored[] = fetch.nodes.nodes;
    for (const node of listed) {
      nodes.set(node.id, node);
    }
  }
  return nodes;
}

// A search window that lost rows shows up here and nowhere else. It is
// recorded rather than failed on: `restrictedContributionsCount` counts
// contributions the token cannot see, so a gap can be a visibility
// difference instead of lost rows.
//
// GitHub counts a pull request once however many reviews it drew, including
// reviews on the login's own pull requests, which the reviews table leaves
// out. So the review total is set against distinct pull requests by the year
// of their first review, after taking off the own ones the archived review
// pages count.
//
// An archive listing exactly as many events as GitHub reports is GitHub's
// own list, so issues and pull requests compare as sets of node IDs and the
// note names the events behind a gap. An archive of another size is stale or
// partial, and the comparison falls back to the totals alone.
export async function crossCheck(
  db: D1Database,
  year: number,
  collection: ContributionsCollection,
  archived: ArchivedYear = {},
): Promise<string | null> {
  const stored = await yearTotals(db, year);
  const reviews =
    archived.reviews?.pullRequests === collection.totalPullRequestReviewContributions
      ? archived.reviews
      : undefined;
  const reported = {
    "pull requests": collection.totalPullRequestContributions,
    reviews: collection.totalPullRequestReviewContributions - (reviews?.own ?? 0),
    issues: collection.totalIssueContributions,
    commits: collection.totalCommitContributions,
  };
  const listed = {
    "pull requests": sameSize(archived.pullRequests, reported["pull requests"]),
    issues: sameSize(archived.issues, reported.issues),
  };
  const differences = await setDifferences(db, year, listed);

  const gaps = TOTALS.flatMap((name) => {
    if (name === "reviews") {
      return reported.reviews === stored.reviews
        ? []
        : [reviewGap(collection.totalPullRequestReviewContributions, reviews?.own, stored.reviews)];
    }
    const difference = name === "commits" ? null : differences[name];
    const named = difference === null ? "" : describeDifference(difference);
    return reported[name] === stored[name] && named === ""
      ? []
      : [`${name} ${reported[name]} vs ${stored[name]}${named}`];
  });
  if (gaps.length === 0) {
    return null;
  }

  return `${year} totals disagree: ${gaps.join(", ")} (restricted ${collection.restrictedContributionsCount})`;
}

function sameSize(
  ids: ReadonlySet<string> | undefined,
  reported: number,
): ReadonlySet<string> | null {
  return ids?.size === reported ? ids : null;
}

// `reviews 75 (38 own) vs 37 PRs`: GitHub's figure as it reports it, the part
// the table excludes by design, and the distinct pull requests the table holds.
function reviewGap(reported: number, own: number | undefined, stored: number): string {
  const excluded = own === undefined ? "" : ` (${own} own)`;
  return `reviews ${reported}${excluded} vs ${stored} PRs`;
}

interface Difference {
  // Counted by GitHub and absent from the table.
  missing: string[];
  // In the table and not counted by GitHub.
  uncounted: string[];
}

// Reads ` (missing I_a, I_b; uncounted I_c)`. Empty when the sets agree.
function describeDifference({ missing, uncounted }: Difference): string {
  const sides = [
    ...(missing.length === 0 ? [] : [`missing ${nameIds(missing)}`]),
    ...(uncounted.length === 0 ? [] : [`uncounted ${nameIds(uncounted)}`]),
  ];
  return sides.length === 0 ? "" : ` (${sides.join("; ")})`;
}

function nameIds(ids: readonly string[]): string {
  const shown = ids.slice(0, NAMED_LIMIT).join(", ");
  return ids.length > NAMED_LIMIT ? `${shown} and ${ids.length - NAMED_LIMIT} more` : shown;
}

const TOTALS = ["pull requests", "reviews", "issues", "commits"] as const;

type Total = (typeof TOTALS)[number];

type Totals = Record<Total, number>;

const SOURCES: Record<Total, string> = {
  "pull requests":
    "SELECT COUNT(*) AS total FROM pull_requests WHERE created_at >= ?1 AND created_at < ?2",
  reviews:
    "SELECT COUNT(*) AS total FROM (SELECT MIN(submitted_at) AS first FROM reviews" +
    " GROUP BY repository_id, pull_request_number) WHERE first >= ?1 AND first < ?2",
  issues: "SELECT COUNT(*) AS total FROM issues WHERE created_at >= ?1 AND created_at < ?2",
  commits:
    "SELECT COALESCE(SUM(commit_count), 0) AS total FROM commit_days WHERE day >= ?1 AND day < ?2",
};

const LISTED = {
  "pull requests": "SELECT id FROM pull_requests WHERE created_at >= ?1 AND created_at < ?2",
  issues: "SELECT id FROM issues WHERE created_at >= ?1 AND created_at < ?2",
} as const;

type Listed = keyof typeof LISTED;

function yearBounds(year: number): [string, string] {
  return [`${year}-01-01`, `${year + 1}-01-01`];
}

async function yearTotals(db: D1Database, year: number): Promise<Totals> {
  const results = await db.batch<{ total: number }>(
    TOTALS.map((name) => db.prepare(SOURCES[name]).bind(...yearBounds(year))),
  );

  // batch answers in the order it was given, so each name reads its own count.
  const counted = (name: Total): number => results[TOTALS.indexOf(name)]?.results[0]?.total ?? 0;

  return {
    "pull requests": counted("pull requests"),
    reviews: counted("reviews"),
    issues: counted("issues"),
    commits: counted("commits"),
  };
}

async function setDifferences(
  db: D1Database,
  year: number,
  listed: Record<Listed, ReadonlySet<string> | null>,
): Promise<Record<Listed, Difference | null>> {
  const difference = async (name: Listed): Promise<Difference | null> => {
    const counted = listed[name];
    if (counted === null) {
      return null;
    }
    const { results } = await db
      .prepare(LISTED[name])
      .bind(...yearBounds(year))
      .all<{ id: string }>();
    const stored = new Set(results.map((row) => row.id));
    return {
      missing: [...counted].filter((id) => !stored.has(id)).toSorted(),
      uncounted: [...stored].filter((id) => !counted.has(id)).toSorted(),
    };
  };

  const [pullRequests, issues] = await Promise.all([
    difference("pull requests"),
    difference("issues"),
  ]);
  return { "pull requests": pullRequests, issues };
}
