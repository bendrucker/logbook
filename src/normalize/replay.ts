// Re-normalizing reads R2 and never calls GitHub, which is what makes a schema
// change cost nothing: bump the shape, replay the archived pages, and the event
// tables rebuild from responses already on disk.
import { z } from "zod";
import { splitContributions } from "../github/calendar";
import {
  CONTRIBUTION_EVENTS_MAX_PAGES,
  contributionEventsTruncated,
} from "../github/contribution-events";
import {
  contributionEventsObject,
  contributionEventsYearPrefix,
  contributionsObject,
  contributionsYearPrefix,
  searchPageNumber,
  searchPrefix,
} from "../github/raw";
import {
  type ContributionConnectionPage,
  type ContributionsCollection,
  contributionsResponse,
  issueContributionsPage,
  issueSearchPage,
  type PageInfo,
  pullRequestContributionsPage,
  pullRequestSearchPage,
  reviewContributionsPage,
  reviewedPullRequestSearchPage,
  reviewsTruncated,
  type SearchPage,
} from "../github/schema";
import { SEARCH_MAX_PAGES, searchTruncated } from "../github/search";
import type { EventKind } from "../github/windows";
import { combineWindows } from "./commit-windows";
import {
  normalizeContributionEvents,
  normalizeSearchPage,
  type RowsChanged,
  writeContributionRows,
} from "./page";
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
  const fetch = await selectFetch(prefixes, (candidate) =>
    readFetch(bucket, kind, prefix, candidate),
  );
  if (fetch === null) {
    return null;
  }

  const rows = await normalizeSearchPage(db, fetch.nodes, fetch.fetchedAt);

  return { fetchedAt: fetch.fetchedAt, truncated: fetch.truncated, rows };
}

// Replays `window` and every narrower window archived under it, which is how
// a year rebuilds from the windows the crawl split it into and how a live run
// totals a day it fetched in parts.
export async function replayContributions(
  db: D1Database,
  bucket: R2Bucket,
  window: string,
): Promise<Replay | null> {
  const { keys } = await list(bucket, { prefix: contributionsYearPrefix(window.slice(0, 4)) });

  // A fetch timestamp is an ISO string, so R2's lexicographic listing puts each
  // window's newest fetch last. A window is one object per fetch, so there is
  // no partial fetch to skip past.
  const newest = new Map<string, { key: string; fetchedAt: string }>();
  for (const key of keys) {
    const object = contributionsObject(key);
    if (object !== null) {
      newest.set(object.window, { key, fetchedAt: object.fetchedAt });
    }
  }

  const reached = within(window, newest);
  if (reached.length === 0) {
    return null;
  }

  const archived = new Map(
    await Promise.all(
      reached.map(async ([name, { key, fetchedAt }]) => {
        const collection = readCollection(await readOne(bucket, key));
        return [name, { fetchedAt, collection }] as const;
      }),
    ),
  );
  const combined = combineWindows(window, archived);
  const fetchedAt = reached.map(([, object]) => object.fetchedAt).toSorted();

  return {
    fetchedAt: fetchedAt.at(-1) ?? "",
    truncated: combined.truncated,
    rows: await writeContributionRows(db, combined.rows),
  };
}

// The listing already says which windows exist, so no child is left out for
// having started after some instant.
const LATEST = new Date(8.64e15);

// The windows the replay reads: `window` and the archived windows the crawl
// split it into, down to the finest. A listing under the year also holds the
// year's other quarters and months, which a narrower replay leaves alone.
function within<Value>(window: string, newest: ReadonlyMap<string, Value>): [string, Value][] {
  const reached: [string, Value][] = [];
  const pending = [window];
  let key = pending.shift();
  while (key !== undefined) {
    const value = newest.get(key);
    if (value !== undefined) {
      reached.push([key, value]);
    }
    pending.push(
      ...splitContributions(key, LATEST)
        .map((child) => child.key)
        .filter((child) => newest.has(child)),
    );
    key = pending.shift();
  }
  return reached;
}

export interface ContributionEventsFetch {
  window: string;
  fetchedAt: string;
  nodes: SearchPageNodes;
  truncated: boolean;
  complete: boolean;
}

export interface ArchivedContributionEvents {
  // The newest fetch of `window` and of each narrower window archived under it,
  // oldest first.
  fetches: ContributionEventsFetch[];
  // Some window under the root dropped events that no archived narrower window
  // recovers.
  truncated: boolean;
}

// The connection pages `window` and the windows the crawl split it into
// archived, read without writing anything. The cross-check reads a year's
// pages through here to name the events behind a gap.
export async function readContributionEvents(
  bucket: R2Bucket,
  kind: EventKind,
  window: string,
): Promise<ArchivedContributionEvents | null> {
  const { keys } = await list(bucket, {
    prefix: contributionEventsYearPrefix(kind, window.slice(0, 4)),
  });

  // Keys list in order, so each window's fetches arrive oldest first and each
  // fetch's pages in the order they were read.
  const archived = new Map<string, Map<string, string[]>>();
  for (const key of keys) {
    const object = contributionEventsObject(key);
    if (object === null) {
      continue;
    }
    const fetches = archived.get(object.window) ?? new Map<string, string[]>();
    archived.set(object.window, fetches);
    fetches.set(object.fetchedAt, [...(fetches.get(object.fetchedAt) ?? []), key]);
  }

  const reached = within(window, archived);
  if (reached.length === 0) {
    return null;
  }

  const selected = await Promise.all(
    reached.map(([name, fetches]) =>
      selectFetch([...fetches.keys()], async (fetchedAt) => ({
        window: name,
        fetchedAt,
        ...contributionEventsFetch(kind, await read(bucket, fetches.get(fetchedAt) ?? [])),
      })),
    ),
  );
  const fetches = selected
    .filter((fetch) => fetch !== null)
    .toSorted((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const byWindow = new Map(fetches.map((fetch) => [fetch.window, fetch]));

  return { fetches, truncated: eventsTruncated(window, byWindow) };
}

// Replays the connection pages under `window`, oldest fetch first, so the
// newest fetch of an event names its repository's `fetched_at`.
export async function replayContributionEvents(
  db: D1Database,
  bucket: R2Bucket,
  kind: EventKind,
  window: string,
  login: string,
): Promise<Replay | null> {
  const archived = await readContributionEvents(bucket, kind, window);
  if (archived === null) {
    return null;
  }

  let rows: RowsChanged = {
    repositories: 0,
    pullRequests: 0,
    reviews: 0,
    issues: 0,
    commitDays: 0,
  };
  // One fetch after another, since a later fetch of the same event or
  // repository has to land after the earlier one it supersedes.
  const pending = [...archived.fetches];
  let fetch = pending.shift();
  while (fetch !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const changed = await normalizeContributionEvents(db, fetch.nodes, login, fetch.fetchedAt);
    rows = {
      repositories: rows.repositories + changed.repositories,
      pullRequests: rows.pullRequests + changed.pullRequests,
      reviews: rows.reviews + changed.reviews,
      issues: rows.issues + changed.issues,
      commitDays: rows.commitDays + changed.commitDays,
    };
    fetch = pending.shift();
  }

  return {
    fetchedAt: archived.fetches.at(-1)?.fetchedAt ?? "",
    truncated: archived.truncated,
    rows,
  };
}

// A window is covered when its own fetch finished whole, or when every window
// it splits into was archived and is covered in turn. A window splits into the
// children that had started by the time it was fetched.
function eventsTruncated(
  key: string,
  fetches: ReadonlyMap<string, ContributionEventsFetch>,
): boolean {
  const fetch = fetches.get(key);
  if (fetch !== undefined && fetch.complete && !fetch.truncated) {
    return false;
  }

  const children = splitContributions(
    key,
    fetch === undefined ? LATEST : new Date(fetch.fetchedAt),
  ).map((child) => child.key);
  return (
    children.length === 0 ||
    children.some((child) => !fetches.has(child) || eventsTruncated(child, fetches))
  );
}

function contributionEventsFetch(
  kind: EventKind,
  pages: readonly RawPage[],
): Omit<ContributionEventsFetch, "window" | "fetchedAt"> {
  switch (kind) {
    case "pr-authored": {
      const parsed = pages.map((page) => connectionPage(pullRequestContributionsPage, page));
      return {
        nodes: { kind, nodes: parsed.flatMap((page) => page.nodes) },
        ...connectionCoverage(pages, parsed),
      };
    }
    case "pr-reviewed": {
      const parsed = pages.map((page) => connectionPage(reviewContributionsPage, page));
      const nodes = parsed.flatMap((page) => page.nodes);
      const { complete, truncated } = connectionCoverage(pages, parsed);
      return {
        nodes: { kind, nodes },
        complete,
        truncated: truncated || nodes.some(reviewsTruncated),
      };
    }
    case "issue": {
      const parsed = pages.map((page) => connectionPage(issueContributionsPage, page));
      return {
        nodes: { kind, nodes: parsed.flatMap((page) => page.nodes) },
        ...connectionCoverage(pages, parsed),
      };
    }
  }
}

function connectionPage<T>(
  schema: z.ZodType<ContributionConnectionPage<T> | null>,
  page: RawPage,
): ContributionConnectionPage<T> {
  const parsed = parse(schema, page);
  if (parsed === null) {
    throw new RawValidationError(page.key, "the response carries no user", null);
  }
  return parsed;
}

function connectionCoverage(
  pages: readonly RawPage[],
  parsed: readonly ContributionConnectionPage<unknown>[],
): { complete: boolean; truncated: boolean } {
  return {
    complete:
      contiguous(pages) &&
      finished(
        parsed.map((page) => page.pageInfo),
        CONTRIBUTION_EVENTS_MAX_PAGES,
      ),
    truncated: contributionEventsTruncated(parsed),
  };
}

function readCollection(page: RawPage): ContributionsCollection {
  const { user } = parse(contributionsResponse, page);
  if (user === null) {
    throw new RawValidationError(page.key, "the response carries no user", null);
  }
  return user.contributionsCollection;
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
async function selectFetch<Fetch extends { complete: boolean }>(
  candidates: readonly string[],
  readCandidate: (candidate: string) => Promise<Fetch>,
): Promise<Fetch | null> {
  const remaining = [...candidates];
  let newest: Fetch | null = null;
  let candidate = remaining.pop();

  while (candidate !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const archived = await readCandidate(candidate);
    if (archived.complete) {
      return archived;
    }

    newest ??= archived;
    candidate = remaining.pop();
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
        // more reviews than one page shorts the window on its own. The live
        // pager applies the same check.
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
    complete:
      contiguous(pages) &&
      finished(
        parsed.map((page) => page.search.pageInfo),
        SEARCH_MAX_PAGES,
      ),
    truncated: parsed.some((page) => searchTruncated(page.search.issueCount)),
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
function finished(pageInfo: readonly PageInfo[], maxPages: number): boolean {
  const last = pageInfo.at(-1);
  if (last === undefined) {
    return false;
  }

  return !last.hasNextPage || pageInfo.length >= maxPages;
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
