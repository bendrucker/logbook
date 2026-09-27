// Every GraphQL document selects `rateLimit` so the extractor reads its
// remaining budget off whatever response it just took.
const gql = (strings: TemplateStringsArray) => strings.raw.join("");

// Baked into the documents below rather than passed as variables. The checks
// that detect a dropped item compare against the totals each response reports,
// never against these.
const MAX_REPOSITORIES = 100;
const NESTED_PAGE_SIZE = 100;

const REPOSITORY_FRAGMENT = gql`
  fragment RepositoryInfo on Repository {
    id
    name
    owner {
      login
    }
    description
    url
    stargazerCount
    primaryLanguage {
      name
      color
    }
    createdAt
    isFork
    visibility
  }
`;

const PAGE_INFO = gql`
  pageInfo {
    hasNextPage
    endCursor
  }
`;

const RATE_LIMIT = gql`
  rateLimit {
    cost
    remaining
    resetAt
  }
`;

// One selection per node type, shared by the search documents and the
// contribution connections so both enumerations hand normalization the same
// shape.
const PULL_REQUEST_FRAGMENT = gql`
  fragment PullRequestInfo on PullRequest {
    __typename
    id
    number
    title
    author {
      login
    }
    createdAt
    mergedAt
    closedAt
    state
    additions
    deletions
    changedFiles
    comments {
      totalCount
    }
    reviews {
      totalCount
    }
    updatedAt
    repository {
      ...RepositoryInfo
    }
  }
`;

const REVIEW_CONNECTION = `
  totalCount
  ${PAGE_INFO}
  nodes {
    id
    state
    submittedAt
  }
`;

// The reviews come off the node's own connection filtered to one author, so
// every document spreading this declares `$login`. A plain template rather than
// `gql`, which keeps only the literal text and would drop the page size.
const REVIEWED_PULL_REQUEST_FRAGMENT = `
  fragment ReviewedPullRequestInfo on PullRequest {
    __typename
    id
    number
    title
    author {
      login
    }
    updatedAt
    reviews(author: $login, first: ${NESTED_PAGE_SIZE}) {
      ${REVIEW_CONNECTION}
    }
    repository {
      ...RepositoryInfo
    }
  }
`;

// The rest of one pull request's reviews, for the rare one whose reviews ran
// past the page the search nested.
export const PULL_REQUEST_REVIEWS = `
  query PullRequestReviews($id: ID!, $login: String!, $first: Int!, $after: String) {
    node(id: $id) {
      ... on PullRequest {
        reviews(author: $login, first: $first, after: $after) {
          ${REVIEW_CONNECTION}
        }
      }
    }

    ${RATE_LIMIT}
  }
`;

const ISSUE_FRAGMENT = gql`
  fragment IssueInfo on Issue {
    __typename
    id
    number
    title
    author {
      login
    }
    createdAt
    closedAt
    state
    comments {
      totalCount
    }
    updatedAt
    repository {
      ...RepositoryInfo
    }
  }
`;

export const PULL_REQUEST_SEARCH = `
  ${REPOSITORY_FRAGMENT}
  ${PULL_REQUEST_FRAGMENT}

  query PullRequestSearch($searchQuery: String!, $first: Int!, $after: String) {
    search(query: $searchQuery, type: ISSUE, first: $first, after: $after) {
      issueCount
      ${PAGE_INFO}
      nodes {
        __typename
        ...PullRequestInfo
      }
    }

    ${RATE_LIMIT}
  }
`;

// A `reviewed-by:` search matches the pull request, so the reviews come off the
// node's own connection filtered to one author.
export const REVIEWED_PULL_REQUEST_SEARCH = `
  ${REPOSITORY_FRAGMENT}
  ${REVIEWED_PULL_REQUEST_FRAGMENT}

  query ReviewedPullRequestSearch(
    $searchQuery: String!
    $login: String!
    $first: Int!
    $after: String
  ) {
    search(query: $searchQuery, type: ISSUE, first: $first, after: $after) {
      issueCount
      ${PAGE_INFO}
      nodes {
        __typename
        ...ReviewedPullRequestInfo
      }
    }

    ${RATE_LIMIT}
  }
`;

export const ISSUE_SEARCH = `
  ${REPOSITORY_FRAGMENT}
  ${ISSUE_FRAGMENT}

  query IssueSearch($searchQuery: String!, $first: Int!, $after: String) {
    search(query: $searchQuery, type: ISSUE, first: $first, after: $after) {
      issueCount
      ${PAGE_INFO}
      nodes {
        __typename
        ...IssueInfo
      }
    }

    ${RATE_LIMIT}
  }
`;

// The contribution connections list what GitHub counts as a contribution, a
// cursor at a time, including issues in repositories that later turned Issues
// off, which search no longer finds.
function contributionConnection(name: string, field: string, fragments: string, spread: string) {
  return `
  ${REPOSITORY_FRAGMENT}
  ${fragments}

  query ${name}(
    $login: String!
    $from: DateTime!
    $to: DateTime!
    $first: Int!
    $after: String
  ) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        ${field}(first: $first, after: $after) {
          totalCount
          ${PAGE_INFO}
          nodes {
            ${spread}
          }
        }
      }
    }

    ${RATE_LIMIT}
  }
`;
}

export const ISSUE_CONTRIBUTIONS = contributionConnection(
  "IssueContributions",
  "issueContributions",
  ISSUE_FRAGMENT,
  "issue { ...IssueInfo }",
);

export const PULL_REQUEST_CONTRIBUTIONS = contributionConnection(
  "PullRequestContributions",
  "pullRequestContributions",
  PULL_REQUEST_FRAGMENT,
  "pullRequest { ...PullRequestInfo }",
);

// One node per pull request reviewed, so the node's pull request carries every
// review the login left on it.
export const PULL_REQUEST_REVIEW_CONTRIBUTIONS = contributionConnection(
  "PullRequestReviewContributions",
  "pullRequestReviewContributions",
  REVIEWED_PULL_REQUEST_FRAGMENT,
  "pullRequest { ...ReviewedPullRequestInfo }",
);

export const CONTRIBUTIONS = `
  ${REPOSITORY_FRAGMENT}

  query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalIssueContributions
        totalRepositoriesWithContributedCommits
        restrictedContributionsCount
        contributionYears
        commitContributionsByRepository(maxRepositories: ${MAX_REPOSITORIES}) {
          repository {
            ...RepositoryInfo
          }
          contributions(first: ${NESTED_PAGE_SIZE}) {
            totalCount
            nodes {
              commitCount
              occurredAt
            }
          }
        }
      }
    }

    ${RATE_LIMIT}
  }
`;
