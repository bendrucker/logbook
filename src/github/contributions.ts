import { GitHubResponseError, graphql, validate, type GraphQLOptions } from "./client";
import { CONTRIBUTIONS } from "./queries";
import { contributionsResponse, type ContributionsCollection, type RateLimit } from "./schema";

export class UnknownUserError extends GitHubResponseError {
  readonly login: string;

  constructor(login: string, body: string) {
    super("UnknownUserError", `GitHub has no user ${login}`, body);
    this.login = login;
  }
}

export interface ContributionsWindow {
  // What names the window's prefix in R2: `2026` for a year, `2026-Q3` for a
  // quarter of one.
  key: string;
  from: Date;
  to: Date;
}

// The collection takes at most a year per request and rejects a wider window,
// so a window still in progress stops at now.
function clipped(key: string, from: Date, end: Date, now: Date): ContributionsWindow {
  return { key, from, to: now < end ? now : end };
}

export function yearWindow(year: number, now: Date): ContributionsWindow {
  return clipped(
    String(year),
    new Date(Date.UTC(year, 0, 1)),
    new Date(Date.UTC(year, 11, 31, 23, 59, 59)),
    now,
  );
}

export const QUARTERS = [1, 2, 3, 4];

export function quarterKey(year: number, quarter: number): string {
  return `${year}-Q${quarter}`;
}

// A quarter spans at most 92 days, so no repository's daily contributions in one
// can overflow a page the way a busy repository's year does.
export function quarterWindows(year: number, now: Date): ContributionsWindow[] {
  return QUARTERS.flatMap((quarter) => {
    const from = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
    if (from > now) {
      return [];
    }
    const end = new Date(Date.UTC(year, quarter * 3, 1) - 1000);
    return clipped(quarterKey(year, quarter), from, end, now);
  });
}

export interface ContributionsResult {
  window: ContributionsWindow;
  collection: ContributionsCollection;
  truncated: boolean;
  rateLimit: RateLimit;
  body: string;
}

// Two fixed lists with no cursor between them: anything past the limit each was
// given is dropped with no error and nothing to follow. The same response
// reports what each list should hold, so the check is exact rather than a guess
// from a list arriving full. A repository's `contributions.totalCount` is its
// commit total for the window, not its number of day nodes, so the days it lost
// show as listed commits short of that total. The collection's own commit total
// catches a loss neither list accounts for.
export function contributionsTruncated(collection: ContributionsCollection): boolean {
  const repositories = collection.commitContributionsByRepository;
  const listed = repositories.map(({ contributions }) => ({
    commits: sum(contributions.nodes.map((day) => day.commitCount)),
    reported: contributions.totalCount,
  }));

  return (
    repositories.length < collection.totalRepositoriesWithContributedCommits ||
    listed.some(({ commits, reported }) => commits < reported) ||
    sum(listed.map(({ commits }) => commits)) < collection.totalCommitContributions
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export async function fetchContributions(
  token: string,
  login: string,
  window: ContributionsWindow,
  options: GraphQLOptions = {},
): Promise<ContributionsResult> {
  const response = await graphql(
    token,
    CONTRIBUTIONS,
    { login, from: window.from.toISOString(), to: window.to.toISOString() },
    options,
  );

  const { user } = validate(contributionsResponse, response.data, response.body);
  if (!user) {
    throw new UnknownUserError(login, response.body);
  }

  const collection = user.contributionsCollection;

  return {
    window,
    collection,
    truncated: contributionsTruncated(collection),
    rateLimit: response.rateLimit,
    body: response.body,
  };
}
