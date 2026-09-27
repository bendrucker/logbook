import { GitHubResponseError, graphql, validate, type GraphQLOptions } from "./client";
import { CONTRIBUTIONS, MAX_REPOSITORIES, NESTED_PAGE_SIZE } from "./queries";
import { contributionsResponse, type ContributionsCollection, type RateLimit } from "./schema";

export { MAX_REPOSITORIES } from "./queries";

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
// given is dropped with no error and nothing to follow. The repository list is
// checked against that limit, and each repository's daily contributions against
// the total the same response reports, since a repository committed to on more
// than a page of days in one year returns only the first page.
// `totalRepositoriesWithContributedCommits` is the count to cross-check the
// first against.
export function contributionsTruncated(collection: ContributionsCollection): boolean {
  return (
    collection.commitContributionsByRepository.length >= MAX_REPOSITORIES ||
    collection.commitContributionsByRepository.some(
      ({ contributions }) => contributions.totalCount > NESTED_PAGE_SIZE,
    )
  );
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
