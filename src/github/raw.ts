import { OBJECT_SUFFIX, pageName, writeOnce } from "../raw-object";
import type { EventKind } from "./windows";

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
  return `${searchFetchPrefix(kind, window, fetchedAt)}${pageName(page)}`;
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
  const id = encodeURIComponent(pullRequest);
  return `${searchReviewsPrefix(kind, window, fetchedAt)}${id}/${pageName(page)}`;
}

// Null for a search page.
export function searchReviewsPullRequest(fetchPrefix: string, key: string): string | null {
  const match = /^reviews\/([^/]+)\/\d+\.json$/.exec(key.slice(fetchPrefix.length));
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
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
  return `${contributionEventsWindowPrefix(kind, window)}${fetchedAt}/${pageName(page)}`;
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

// One listing finds a window and every narrower window the crawl split it
// into. Each key starts with its parent's, except a quarter's months, which
// start with the year, and a sub-day range's hours, which start with the day.
export function contributionsWithinPrefix(window: string): string {
  if (/^\d{4}-Q\d$/.test(window)) {
    return `raw/contributions/${window.slice(0, 4)}`;
  }
  return `raw/contributions/${window.includes("--") ? window.slice(0, 10) : window}`;
}

export function contributionsObject(key: string): { window: string; fetchedAt: string } | null {
  const match = /^raw\/contributions\/([^/]+)\/([^/]+)\.json$/.exec(key);
  if (match === null) {
    return null;
  }
  const [, window = "", fetchedAt = ""] = match;
  return { window, fetchedAt };
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
