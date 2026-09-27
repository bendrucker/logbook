import type {
  ContributionsCollection,
  IssueNode,
  PullRequestNode,
  ReviewedPullRequestNode,
} from "../github/schema";
import type { EventKind } from "../github/windows";
import {
  type Repository,
  upsertCommitDays,
  upsertIssues,
  upsertPullRequests,
  upsertRepositories,
  upsertReviews,
} from "../store";
import {
  type ContributionRows,
  contributionRows,
  issueRows,
  pullRequestRows,
  reviewRows,
} from "./rows";

export interface RowsChanged {
  repositories: number;
  pullRequests: number;
  reviews: number;
  issues: number;
  commitDays: number;
}

const UNCHANGED: RowsChanged = {
  repositories: 0,
  pullRequests: 0,
  reviews: 0,
  issues: 0,
  commitDays: 0,
};

type NodesByKind = {
  "pr-authored": PullRequestNode;
  "pr-reviewed": ReviewedPullRequestNode;
  issue: IssueNode;
};

// The kind travels with the nodes rather than beside them. Passed as separate
// arguments the two carry no type-level tie, and every branch reading the nodes
// would need a cast to recover the one the kind already names.
export type SearchPageNodes = {
  [Kind in EventKind]: { kind: Kind; nodes: readonly NodesByKind[Kind][] };
}[EventKind];

export async function normalizeSearchPage(
  db: D1Database,
  page: SearchPageNodes,
  fetchedAt: string,
): Promise<RowsChanged> {
  switch (page.kind) {
    case "pr-authored": {
      const rows = page.nodes.map((node) => pullRequestRows(node, fetchedAt));
      const repositories = await writeRepositories(db, rows);
      const pullRequests = await upsertPullRequests(
        db,
        rows.map((row) => row.pullRequest),
      );
      return { ...UNCHANGED, repositories, pullRequests };
    }
    case "pr-reviewed": {
      const rows = page.nodes.map((node) => reviewRows(node, fetchedAt));
      const repositories = await writeRepositories(db, rows);
      const reviews = await upsertReviews(
        db,
        rows.flatMap((row) => row.reviews),
      );
      return { ...UNCHANGED, repositories, reviews };
    }
    case "issue": {
      const rows = page.nodes.map((node) => issueRows(node, fetchedAt));
      const repositories = await writeRepositories(db, rows);
      const issues = await upsertIssues(
        db,
        rows.map((row) => row.issue),
      );
      return { ...UNCHANGED, repositories, issues };
    }
  }
}

export function normalizeContributions(
  db: D1Database,
  collection: ContributionsCollection,
  fetchedAt: string,
): Promise<RowsChanged> {
  return writeContributionRows(db, contributionRows(collection, fetchedAt));
}

export async function writeContributionRows(
  db: D1Database,
  rows: ContributionRows,
): Promise<RowsChanged> {
  const repositories = await upsertRepositories(db, dedupe(rows.repositories));
  const commitDays = await upsertCommitDays(db, rows.commitDays);

  return { ...UNCHANGED, repositories, commitDays };
}

// Repositories go first because every event table has a foreign key to them.
function writeRepositories(
  db: D1Database,
  rows: readonly { repository: Repository }[],
): Promise<number> {
  return upsertRepositories(db, dedupe(rows.map((row) => row.repository)));
}

// A page of a hundred nodes usually names far fewer repositories, and the same
// id twice in one batch is a statement that writes what the one before it did.
// The last row for an id wins.
function dedupe(rows: readonly Repository[]): Repository[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}
