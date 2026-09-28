import type { ContributionsWindow } from "./calendar";
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
