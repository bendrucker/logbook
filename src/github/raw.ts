import type { EventKind } from "./windows";

// R2 lists lexicographically, so a page number is padded to keep one fetch's
// pages in the order they were read.
const PAGE_DIGITS = 4;

export const OBJECT_SUFFIX = ".json";

// Replay lists these prefixes to find what a window archived, so the layout has
// one definition here rather than a listing that has to match a key builder.
export function searchPrefix(kind: EventKind, window: string): string {
  return `raw/search/${kind}/${window}/`;
}

function searchFetchPrefix(kind: EventKind, window: string, fetchedAt: string): string {
  return `${searchPrefix(kind, window)}${fetchedAt}/`;
}

export function searchKey(
  kind: EventKind,
  window: string,
  fetchedAt: string,
  page: number,
): string {
  const name = String(page).padStart(PAGE_DIGITS, "0");
  return `${searchFetchPrefix(kind, window, fetchedAt)}${name}${OBJECT_SUFFIX}`;
}

// A follow-up that read a pull request's reviews past the nested page lands
// under the fetch it completes, beside the search pages rather than numbered
// among them. Legacy node IDs are base64 and can hold a slash, so the ID is
// encoded to stay one path segment.
function searchReviewsPrefix(kind: EventKind, window: string, fetchedAt: string): string {
  return `${searchFetchPrefix(kind, window, fetchedAt)}reviews/`;
}

export function searchReviewsKey(
  kind: EventKind,
  window: string,
  fetchedAt: string,
  pullRequest: string,
  page: number,
): string {
  const name = String(page).padStart(PAGE_DIGITS, "0");
  const id = encodeURIComponent(pullRequest);
  return `${searchReviewsPrefix(kind, window, fetchedAt)}${id}/${name}${OBJECT_SUFFIX}`;
}

// Null for a search page.
export function searchReviewsPullRequest(fetchPrefix: string, key: string): string | null {
  const match = /^reviews\/([^/]+)\/\d+\.json$/.exec(key.slice(fetchPrefix.length));
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

// Replay counts a fetch's pages against the highest one it archived, so the
// number `searchKey` padded has to read back off a listed key.
export function searchPageNumber(key: string): number | null {
  if (!key.endsWith(OBJECT_SUFFIX)) {
    return null;
  }

  const name = key.slice(key.lastIndexOf("/") + 1, -OBJECT_SUFFIX.length);

  return /^\d+$/.test(name) ? Number(name) : null;
}

// The contribution connections page like search, so their pages mirror the
// search layout under a prefix of their own, named by the event kind the nodes
// normalize as.
function contributionEventsWindowPrefix(kind: EventKind, window: string): string {
  return `raw/contribution-events/${kind}/${window}/`;
}

export function contributionEventsKey(
  kind: EventKind,
  window: string,
  fetchedAt: string,
  page: number,
): string {
  const name = String(page).padStart(PAGE_DIGITS, "0");
  return `${contributionEventsWindowPrefix(kind, window)}${fetchedAt}/${name}${OBJECT_SUFFIX}`;
}

// Window keys start with their year, as the contributions windows do, so one
// listing under the year finds every window the crawl split it into.
export function contributionEventsYearPrefix(kind: EventKind, year: string): string {
  return `raw/contribution-events/${kind}/${year}`;
}

export function contributionEventsObject(
  key: string,
): { window: string; fetchedAt: string; page: number } | null {
  const match = /^raw\/contribution-events\/[^/]+\/([^/]+)\/([^/]+)\/(\d+)\.json$/.exec(key);
  if (match === null) {
    return null;
  }
  const [, window = "", fetchedAt = "", page = ""] = match;
  return { window, fetchedAt, page: Number(page) };
}

export function contributionsPrefix(window: string): string {
  return `raw/contributions/${window}/`;
}

export function contributionsKey(window: string, fetchedAt: string): string {
  return `${contributionsPrefix(window)}${fetchedAt}${OBJECT_SUFFIX}`;
}

// Every window key starts with its year, so one listing under the year finds
// the year's windows at every depth, from `2015/` through the hour ranges.
export function contributionsYearPrefix(year: string): string {
  return `raw/contributions/${year}`;
}

export function contributionsObject(key: string): { window: string; fetchedAt: string } | null {
  const match = /^raw\/contributions\/([^/]+)\/([^/]+)\.json$/.exec(key);
  if (match === null) {
    return null;
  }
  const [, window = "", fetchedAt = ""] = match;
  return { window, fetchedAt };
}

// Re-running a window writes new pages under a new fetch timestamp rather
// than replacing what a previous run saw, keeping a normalization bug
// diagnosable against the bytes that caused it. A false return means the key
// was already there.
export async function writeOnce(bucket: R2Bucket, key: string, body: string): Promise<boolean> {
  const written = await bucket.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });

  return written !== null;
}

export interface SearchArchive {
  kind: EventKind;
  window: string;
  fetchedAt: string;
  page: number;
  body: string;
}

export function archiveSearchPage(bucket: R2Bucket, archive: SearchArchive): Promise<boolean> {
  const { kind, window, fetchedAt, page, body } = archive;
  return writeOnce(bucket, searchKey(kind, window, fetchedAt, page), body);
}

export interface SearchReviewsArchive {
  kind: EventKind;
  window: string;
  fetchedAt: string;
  pullRequest: string;
  page: number;
  body: string;
}

export function archiveSearchReviews(
  bucket: R2Bucket,
  archive: SearchReviewsArchive,
): Promise<boolean> {
  const { kind, window, fetchedAt, pullRequest, page, body } = archive;
  return writeOnce(bucket, searchReviewsKey(kind, window, fetchedAt, pullRequest, page), body);
}

export interface ContributionsArchive {
  window: string;
  fetchedAt: string;
  body: string;
}

export function archiveContributions(
  bucket: R2Bucket,
  archive: ContributionsArchive,
): Promise<boolean> {
  return writeOnce(bucket, contributionsKey(archive.window, archive.fetchedAt), archive.body);
}

export interface ContributionEventsArchive {
  kind: EventKind;
  window: string;
  fetchedAt: string;
  page: number;
  body: string;
}

export function archiveContributionEventsPage(
  bucket: R2Bucket,
  archive: ContributionEventsArchive,
): Promise<boolean> {
  const { kind, window, fetchedAt, page, body } = archive;
  return writeOnce(bucket, contributionEventsKey(kind, window, fetchedAt, page), body);
}
