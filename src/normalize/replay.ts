// Re-normalizing reads R2 and never calls GitHub, which is what makes a schema
// change cost nothing: bump the shape, replay the archived pages, and the event
// tables rebuild from responses already on disk.
import { z } from "zod";
import {
  type ContributionsWindow,
  contributionsTruncated,
  quarterWindows,
} from "../github/contributions";
import {
  contributionsKey,
  contributionsPrefix,
  OBJECT_SUFFIX,
  searchPageNumber,
  searchPrefix,
} from "../github/raw";
import {
  type ContributionsCollection,
  contributionsResponse,
  issueSearchPage,
  pullRequestSearchPage,
  reviewedPullRequestSearchPage,
  reviewsTruncated,
  type SearchPage,
} from "../github/schema";
import { SEARCH_MAX_PAGES, SEARCH_MAX_RESULTS } from "../github/search";
import type { EventKind } from "../github/windows";
import { normalizeContributions, normalizeSearchPage, type RowsChanged } from "./page";
import type { SearchPageNodes } from "./page";

export class RawObjectError extends Error {
  readonly key: string;

  // The name is a literal per subclass rather than the constructor's own, which
  // a minified build would rename.
  constructor(name: string, key: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = name;
    this.key = key;
  }
}

export class RawValidationError extends RawObjectError {
  constructor(key: string, message: string, cause: unknown) {
    super("RawValidationError", key, `${key} did not validate: ${message}`, { cause });
  }
}

export class MissingRawObjectError extends RawObjectError {
  constructor(key: string) {
    super("MissingRawObjectError", key, `${key} is not in the raw bucket`);
  }
}

export interface Replay {
  // `fetchedAt` becomes `repositories.fetched_at`, so the row records when
  // GitHub was asked rather than when the replay ran.
  fetchedAt: string;
  // GitHub returned less than the query matched, so the rebuilt window is short
  // by however much it silently dropped.
  truncated: boolean;
  rows: RowsChanged;
}

// Null means nothing is archived under the window, which a caller walking every
// month back to 2012 sees for every month it never fetched.
export async function replaySearchWindow(
  db: D1Database,
  bucket: R2Bucket,
  kind: EventKind,
  window: string,
): Promise<Replay | null> {
  const prefix = searchPrefix(kind, window);
  const { prefixes } = await list(bucket, { prefix, delimiter: "/" });
  const fetch = await selectFetch(bucket, kind, prefix, prefixes);
  if (fetch === null) {
    return null;
  }

  const rows = await normalizeSearchPage(db, fetch.nodes, fetch.fetchedAt);

  return { fetchedAt: fetch.fetchedAt, truncated: fetch.truncated, rows };
}

export async function replayContributions(
  db: D1Database,
  bucket: R2Bucket,
  year: number,
): Promise<Replay | null> {
  const prefix = contributionsPrefix(String(year));
  const { keys } = await list(bucket, { prefix });

  // A fetch timestamp is an ISO string, so R2's lexicographic listing puts the
  // newest object last. A year is one object per fetch, so there is no partial
  // fetch to skip past.
  const key = keys.at(-1);
  if (key === undefined) {
    return null;
  }

  const collection = readCollection(await readOne(bucket, key));
  const fetchedAt = key.slice(prefix.length, -OBJECT_SUFFIX.length);
  const rows = await normalizeContributions(db, collection, fetchedAt);
  if (!contributionsTruncated(collection)) {
    return { fetchedAt, truncated: false, rows };
  }

  // A sync that found the year truncated archived its quarters under the same
  // fetch timestamp, and those hold the days the yearly page dropped. One the
  // rate limit stopped partway archived fewer quarters than the year had begun.
  const windows = quarterWindows(year, new Date(fetchedAt));
  const quarters = await readQuarters(bucket, windows, fetchedAt);
  const quarterRows = await Promise.all(
    quarters.map((quarter) => normalizeContributions(db, quarter, fetchedAt)),
  );

  return {
    fetchedAt,
    truncated: quarters.length < windows.length || quarters.some(contributionsTruncated),
    rows: quarterRows.reduce(addRows, rows),
  };
}

async function readQuarters(
  bucket: R2Bucket,
  windows: readonly ContributionsWindow[],
  fetchedAt: string,
): Promise<ContributionsCollection[]> {
  const objects = await Promise.all(
    windows.map((window) => bucket.get(contributionsKey(window.key, fetchedAt))),
  );
  const pages = await Promise.all(
    objects.flatMap((object) =>
      object === null ? [] : object.text().then((body) => ({ key: object.key, body })),
    ),
  );

  return pages.map(readCollection);
}

function readCollection(page: RawPage): ContributionsCollection {
  const { user } = parse(contributionsResponse, page);
  if (user === null) {
    throw new RawValidationError(page.key, "the response carries no user", null);
  }
  return user.contributionsCollection;
}

function addRows(a: RowsChanged, b: RowsChanged): RowsChanged {
  return {
    repositories: a.repositories + b.repositories,
    pullRequests: a.pullRequests + b.pullRequests,
    reviews: a.reviews + b.reviews,
    issues: a.issues + b.issues,
    commitDays: a.commitDays + b.commitDays,
  };
}

interface RawPage {
  key: string;
  body: string;
}

interface SearchFetch {
  fetchedAt: string;
  nodes: SearchPageNodes;
  truncated: boolean;
  // False when the archive holds fewer pages than the fetch read, which a run
  // interrupted mid-pagination leaves behind.
  complete: boolean;
}

// A fetch timestamp is an ISO string, so R2's lexicographic listing puts the
// newest fetch last. A newer fetch that stopped mid-pagination holds a fraction
// of the window, so the search walks back to the last one that finished. When
// none did, the newest is still the most that was ever archived.
async function selectFetch(
  bucket: R2Bucket,
  kind: EventKind,
  prefix: string,
  prefixes: readonly string[],
): Promise<SearchFetch | null> {
  const candidates = [...prefixes];
  let newest: SearchFetch | null = null;
  let candidate = candidates.pop();

  while (candidate !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const archived = await readFetch(bucket, kind, prefix, candidate);
    if (archived.complete) {
      return archived;
    }

    newest ??= archived;
    candidate = candidates.pop();
  }

  return newest;
}

async function readFetch(
  bucket: R2Bucket,
  kind: EventKind,
  prefix: string,
  fetchPrefix: string,
): Promise<SearchFetch> {
  const { keys } = await list(bucket, { prefix: fetchPrefix });
  const pages = await read(bucket, keys);

  return { fetchedAt: fetchPrefix.slice(prefix.length, -1), ...searchFetch(kind, pages) };
}

function searchFetch(kind: EventKind, pages: readonly RawPage[]): Omit<SearchFetch, "fetchedAt"> {
  switch (kind) {
    case "pr-authored": {
      const parsed = pages.map((page) => parse(pullRequestSearchPage, page));
      return {
        nodes: { kind, nodes: parsed.flatMap((page) => page.search.nodes) },
        ...coverage(pages, parsed),
      };
    }
    case "pr-reviewed": {
      const parsed = pages.map((page) => parse(reviewedPullRequestSearchPage, page));
      const nodes = parsed.flatMap((page) => page.search.nodes);
      const { complete, truncated } = coverage(pages, parsed);
      return {
        nodes: { kind, nodes },
        complete,
        // The reviews sub-connection carries no cursor, so a pull request with
        // more reviews than one page shorts the window on its own.
        truncated: truncated || nodes.some(reviewsTruncated),
      };
    }
    case "issue": {
      const parsed = pages.map((page) => parse(issueSearchPage, page));
      return {
        nodes: { kind, nodes: parsed.flatMap((page) => page.search.nodes) },
        ...coverage(pages, parsed),
      };
    }
  }
}

function coverage(
  pages: readonly RawPage[],
  parsed: readonly SearchPage<unknown>[],
): { complete: boolean; truncated: boolean } {
  return {
    complete: contiguous(pages) && finished(parsed),
    truncated: parsed.some((page) => page.search.issueCount >= SEARCH_MAX_RESULTS),
  };
}

// Keys sort on the zero-padded page number `searchKey` wrote, so a fetch whose
// last page numbers as many pages as were listed lost none along the way.
function contiguous(pages: readonly RawPage[]): boolean {
  const last = pages.at(-1);

  return last !== undefined && searchPageNumber(last.key) === pages.length;
}

// A fetch ends when GitHub announces no successor or when the paginator hits
// the bound it stops at rather than following a cursor GitHub would reject.
function finished(parsed: readonly SearchPage<unknown>[]): boolean {
  const last = parsed.at(-1);
  if (last === undefined) {
    return false;
  }

  return !last.search.pageInfo.hasNextPage || parsed.length >= SEARCH_MAX_PAGES;
}

interface Listing {
  keys: string[];
  prefixes: string[];
}

async function list(bucket: R2Bucket, options: R2ListOptions): Promise<Listing> {
  const listing: Listing = { keys: [], prefixes: [] };
  let cursor: string | undefined;
  let remaining = true;

  while (remaining) {
    // eslint-disable-next-line no-await-in-loop
    const listed = await bucket.list({ ...options, cursor });
    listing.keys.push(...listed.objects.map((object) => object.key));
    listing.prefixes.push(...listed.delimitedPrefixes);
    remaining = listed.truncated;
    cursor = listed.truncated ? listed.cursor : undefined;
  }

  return listing;
}

function read(bucket: R2Bucket, keys: readonly string[]): Promise<RawPage[]> {
  return Promise.all(keys.map((key) => readOne(bucket, key)));
}

async function readOne(bucket: R2Bucket, key: string): Promise<RawPage> {
  const object = await bucket.get(key);
  if (object === null) {
    throw new MissingRawObjectError(key);
  }

  return { key, body: await object.text() };
}

// The archived body is the whole GraphQL response, so a page schema applies to
// its `data` rather than to the object on disk.
const envelope = z.object({ data: z.unknown() });

function parse<T>(schema: z.ZodType<T>, page: RawPage): T {
  const { data } = check(envelope, json(page), page.key);

  return check(schema, data, page.key);
}

function json(page: RawPage): unknown {
  try {
    return JSON.parse(page.body);
  } catch (error) {
    throw new RawValidationError(page.key, "the body is not JSON", error);
  }
}

function check<T>(schema: z.ZodType<T>, value: unknown, key: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RawValidationError(key, parsed.error.message, parsed.error);
  }

  return parsed.data;
}
