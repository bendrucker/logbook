// Re-normalizing reads R2 and never calls GitHub, which is what makes a schema
// change cost nothing: bump the shape, replay the archived pages, and the event
// tables rebuild from responses already on disk.
import { z } from "zod";
import { OPEN_CONNECTIONS, mapConcurrent } from "../concurrency";
import { splitContributions } from "../github/calendar";
import {
  CONTRIBUTION_EVENTS_MAX_PAGES,
  contributionEventsTruncated,
} from "../github/contribution-events";
import {
  contributionEventsObject,
  contributionEventsYearPrefix,
  contributionsObject,
  contributionsWithinPrefix,
  searchPageNumber,
  searchPrefix,
  searchReviewsPullRequest,
} from "../github/raw";
import { withReviews } from "../github/reviews";
import {
  type ContributionConnectionPage,
  type ContributionsCollection,
  contributionsResponse,
  issueContributionsPage,
  issueSearchPage,
  type PageInfo,
  pullRequestContributionsPage,
  pullRequestReviewsPage,
  pullRequestSearchPage,
  type ReviewedPullRequestNode,
  reviewContributionsPage,
  reviewedPullRequestSearchPage,
  reviewsTruncated,
  type SearchPage,
} from "../github/schema";
import { SEARCH_MAX_PAGES, searchTruncated } from "../github/search";
import type { EventKind } from "../github/windows";
import { unhandled } from "../unhandled";
import { ArchivedWindows } from "./commit-windows";
import {
  normalizeContributionEvents,
  normalizeSearchPage,
  type RowsChanged,
  type SearchPageNodes,
  UNCHANGED,
  writeContributionRows,
} from "./page";

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
  const prefixes: string[] = [];
  for await (const listing of listed(bucket, { prefix, delimiter: "/" })) {
    prefixes.push(...listing.delimitedPrefixes);
  }

  // Nothing is written until the replay knows which fetch it is writing.
  const fetch = await selectFetch(prefixes, (candidate) =>
    listFetch(bucket, kind, prefix, candidate),
  );
  if (fetch === null) {
    return null;
  }

  return { fetchedAt: fetch.fetchedAt, ...(await writeFetch(db, bucket, fetch)) };
}

// Replays `window` and every narrower window archived under it.
export async function replayContributions(
  db: D1Database,
  bucket: R2Bucket,
  window: string,
): Promise<Replay | null> {
  // A fetch timestamp is an ISO string, so R2's lexicographic listing puts each
  // window's newest fetch last. A window is one object per fetch, so there is
  // no partial fetch to skip past.
  const newest = new Map<string, { key: string; fetchedAt: string }>();
  for await (const key of keys(bucket, contributionsWithinPrefix(window))) {
    const object = contributionsObject(key);
    if (object !== null) {
      newest.set(object.window, { key, fetchedAt: object.fetchedAt });
    }
  }

  const reached = within(window, newest);
  if (reached.length === 0) {
    return null;
  }

  const archived = new ArchivedWindows();
  const collections = mapConcurrent(
    reached,
    OPEN_CONNECTIONS,
    async ([name, { key, fetchedAt }]) => ({
      name,
      fetchedAt,
      collection: readCollection(await readOne(bucket, key)),
    }),
  );
  for await (const { name, fetchedAt, collection } of collections) {
    archived.add(name, collection, fetchedAt);
  }
  const combined = archived.combine(window);
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
// split it into, down to the finest. A quarter's listing under the year also
// holds the year's other quarters and months, which the replay leaves alone.
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
// archived, read without writing anything.
export async function readContributionEvents(
  bucket: R2Bucket,
  kind: EventKind,
  window: string,
): Promise<ArchivedContributionEvents | null> {
  // Keys list in order, so each window's fetches arrive oldest first and each
  // fetch's pages in the order they were read.
  const archived = new Map<string, Map<string, string[]>>();
  for await (const key of keys(bucket, contributionEventsYearPrefix(kind, window.slice(0, 4)))) {
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

  // One window at a time, so the reads of one fetch's pages are the only ones
  // open.
  const selected: ContributionEventsFetch[] = [];
  for (const [name, fetches] of reached) {
    // oxlint-disable-next-line no-await-in-loop -- one window's page reads hold the connections
    const fetch = await selectFetch([...fetches.keys()], async (fetchedAt) => ({
      window: name,
      fetchedAt,
      ...(await readEventsFetch(bucket, kind, fetches.get(fetchedAt) ?? [])),
    }));
    if (fetch !== null) {
      selected.push(fetch);
    }
  }
  const fetches = selected.toSorted((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
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

  let rows = UNCHANGED;
  // One fetch after another, since a later fetch of the same event or
  // repository has to land after the earlier one it supersedes.
  for (const fetch of archived.fetches) {
    // oxlint-disable-next-line no-await-in-loop -- a later fetch supersedes an earlier one
    const changed = await normalizeContributionEvents(db, fetch.nodes, login, fetch.fetchedAt);
    rows = added(rows, changed);
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

async function readEventsFetch(
  bucket: R2Bucket,
  kind: EventKind,
  pageKeys: readonly string[],
): Promise<Omit<ContributionEventsFetch, "window" | "fetchedAt">> {
  switch (kind) {
    case "pr-authored": {
      const parsed = await readParsed(bucket, pageKeys, OPEN_CONNECTIONS, (page) =>
        connectionPage(pullRequestContributionsPage, page),
      );
      return {
        nodes: { kind, nodes: parsed.flatMap((page) => page.nodes) },
        ...connectionCoverage(pageKeys, parsed),
      };
    }
    case "pr-reviewed": {
      const parsed = await readParsed(bucket, pageKeys, OPEN_CONNECTIONS, (page) =>
        connectionPage(reviewContributionsPage, page),
      );
      const nodes = parsed.flatMap((page) => page.nodes);
      const { complete, truncated } = connectionCoverage(pageKeys, parsed);
      return {
        nodes: { kind, nodes },
        complete,
        truncated: truncated || nodes.some(reviewsTruncated),
      };
    }
    case "issue": {
      const parsed = await readParsed(bucket, pageKeys, OPEN_CONNECTIONS, (page) =>
        connectionPage(issueContributionsPage, page),
      );
      return {
        nodes: { kind, nodes: parsed.flatMap((page) => page.nodes) },
        ...connectionCoverage(pageKeys, parsed),
      };
    }
    default:
      throw unhandled(kind);
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
  pageKeys: readonly string[],
  parsed: readonly ContributionConnectionPage<unknown>[],
): { complete: boolean; truncated: boolean } {
  return {
    complete:
      contiguous(pageKeys) &&
      finished(parsed.at(-1)?.pageInfo, parsed.length, CONTRIBUTION_EVENTS_MAX_PAGES),
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

// A search fetch before any other page is read.
interface SearchFetch {
  fetchedAt: string;
  kind: EventKind;
  pageKeys: string[];
  // Each pull request's review follow-ups, in the order they were read.
  reviewKeys: ReadonlyMap<string, readonly string[]>;
  // Null when the keys already show a page missing, which settles the fetch
  // without reading it.
  last: SearchPageRead | null;
  // False when the archive holds fewer pages than the fetch read, which a run
  // interrupted mid-pagination leaves behind.
  complete: boolean;
}

interface SearchPageRead {
  key: string;
  nodes: SearchPageNodes;
  pageInfo: PageInfo;
  truncated: boolean;
}

// A fetch timestamp is an ISO string, so R2's lexicographic listing puts the
// newest fetch last. A newer fetch that stopped mid-pagination holds a fraction
// of the window, so the search walks back to the last one that finished. When
// none did, the newest is still the most that was ever archived.
async function selectFetch<Fetch extends { complete: boolean }>(
  candidates: readonly string[],
  readCandidate: (candidate: string) => Promise<Fetch>,
): Promise<Fetch | null> {
  let newest: Fetch | null = null;

  for (const candidate of candidates.toReversed()) {
    // oxlint-disable-next-line no-await-in-loop -- an older fetch is read only when every newer one stopped short
    const archived = await readCandidate(candidate);
    if (archived.complete) {
      return archived;
    }

    newest ??= archived;
  }

  return newest;
}

async function listFetch(
  bucket: R2Bucket,
  kind: EventKind,
  prefix: string,
  fetchPrefix: string,
): Promise<SearchFetch> {
  const pageKeys: string[] = [];
  const reviewKeys = new Map<string, string[]>();
  for await (const key of keys(bucket, fetchPrefix)) {
    const pullRequest = searchReviewsPullRequest(fetchPrefix, key);
    if (pullRequest === null) {
      pageKeys.push(key);
    } else {
      reviewKeys.set(pullRequest, [...(reviewKeys.get(pullRequest) ?? []), key]);
    }
  }

  const lastKey = pageKeys.at(-1);
  const last =
    lastKey === undefined || !contiguous(pageKeys)
      ? null
      : parseSearchPage(kind, await readOne(bucket, lastKey));

  return {
    fetchedAt: fetchPrefix.slice(prefix.length, -1),
    kind,
    pageKeys,
    reviewKeys,
    last,
    complete: finished(last?.pageInfo, pageKeys.length, SEARCH_MAX_PAGES),
  };
}

// Writes a fetch's pages as they are read, in key order, so a node two pages
// list keeps the later page's copy.
async function writeFetch(
  db: D1Database,
  bucket: R2Bucket,
  fetch: SearchFetch,
): Promise<Omit<Replay, "fetchedAt">> {
  const pages = mapConcurrent(fetch.pageKeys, OPEN_CONNECTIONS, async (key) => {
    const page =
      key === fetch.last?.key
        ? fetch.last
        : parseSearchPage(fetch.kind, await readOne(bucket, key));
    return withFollowUps(bucket, page, fetch.reviewKeys);
  });

  let rows = UNCHANGED;
  let truncated = false;
  for await (const page of pages) {
    rows = added(rows, await normalizeSearchPage(db, page.nodes, fetch.fetchedAt));
    truncated ||= page.truncated;
  }

  return { rows, truncated };
}

function parseSearchPage(kind: EventKind, page: RawPage): SearchPageRead {
  switch (kind) {
    case "pr-authored": {
      const { search } = parse(pullRequestSearchPage, page);
      return searchPageRead(page.key, { kind, nodes: search.nodes }, search);
    }
    case "pr-reviewed": {
      const { search } = parse(reviewedPullRequestSearchPage, page);
      return searchPageRead(page.key, { kind, nodes: search.nodes }, search);
    }
    case "issue": {
      const { search } = parse(issueSearchPage, page);
      return searchPageRead(page.key, { kind, nodes: search.nodes }, search);
    }
    default:
      throw unhandled(kind);
  }
}

function searchPageRead(
  key: string,
  nodes: SearchPageNodes,
  search: SearchPage<unknown>["search"],
): SearchPageRead {
  return {
    key,
    nodes,
    pageInfo: search.pageInfo,
    truncated: searchTruncated(search.issueCount),
  };
}

// A pull request with more reviews than its nested page and its follow-ups
// read shorts the window on its own.
async function withFollowUps(
  bucket: R2Bucket,
  page: SearchPageRead,
  reviewKeys: ReadonlyMap<string, readonly string[]>,
): Promise<SearchPageRead> {
  if (page.nodes.kind !== "pr-reviewed") {
    return page;
  }

  const nodes: ReviewedPullRequestNode[] = [];
  // One follow-up read at a time, since the page reads beside this one already
  // hold the other connections. Almost no pull request has one.
  for (const node of page.nodes.nodes) {
    // oxlint-disable-next-line no-await-in-loop -- the page reads beside this one hold the other connections
    const reviews = await readParsed(bucket, reviewKeys.get(node.id) ?? [], 1, (followUp) =>
      parse(pullRequestReviewsPage, followUp),
    );
    nodes.push(withReviews(node, reviews));
  }

  return {
    ...page,
    nodes: { kind: page.nodes.kind, nodes },
    truncated: page.truncated || nodes.some(reviewsTruncated),
  };
}

// Keys sort on the zero-padded page number `searchKey` wrote, so a fetch whose
// last page numbers as many pages as were listed lost none along the way.
function contiguous(pageKeys: readonly string[]): boolean {
  const last = pageKeys.at(-1);

  return last !== undefined && searchPageNumber(last) === pageKeys.length;
}

// A fetch ends when GitHub announces no successor or when the paginator hits
// the bound it stops at rather than following a cursor GitHub would reject.
function finished(last: PageInfo | undefined, pages: number, maxPages: number): boolean {
  if (last === undefined) {
    return false;
  }

  return !last.hasNextPage || pages >= maxPages;
}

function added(rows: RowsChanged, changed: RowsChanged): RowsChanged {
  return {
    repositories: rows.repositories + changed.repositories,
    pullRequests: rows.pullRequests + changed.pullRequests,
    reviews: rows.reviews + changed.reviews,
    issues: rows.issues + changed.issues,
    commitDays: rows.commitDays + changed.commitDays,
  };
}

// R2 lists a thousand keys at a time, and each listing is yielded as it lands
// rather than after the last.
async function* listed(bucket: R2Bucket, options: R2ListOptions): AsyncGenerator<R2Objects> {
  let cursor: string | undefined;
  let remaining = true;

  while (remaining) {
    // oxlint-disable-next-line no-await-in-loop -- each listing needs the cursor the last one returned
    const listing = await bucket.list({ ...options, cursor });
    yield listing;
    remaining = listing.truncated;
    cursor = listing.truncated ? listing.cursor : undefined;
  }
}

async function* keys(bucket: R2Bucket, prefix: string): AsyncGenerator<string> {
  for await (const listing of listed(bucket, { prefix })) {
    yield* listing.objects.map((object) => object.key);
  }
}

// Concurrent reads still come back in key order.
async function readParsed<T>(
  bucket: R2Bucket,
  pageKeys: readonly string[],
  limit: number,
  parsePage: (page: RawPage) => T,
): Promise<T[]> {
  const parsed: T[] = [];
  const pages = mapConcurrent(pageKeys, limit, async (key) =>
    parsePage(await readOne(bucket, key)),
  );
  for await (const page of pages) {
    parsed.push(page);
  }
  return parsed;
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
