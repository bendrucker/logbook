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

// Replay counts a fetch's pages against the highest one it archived, so the
// number `searchKey` padded has to read back off a listed key.
export function searchPageNumber(key: string): number | null {
  if (!key.endsWith(OBJECT_SUFFIX)) {
    return null;
  }

  const name = key.slice(key.lastIndexOf("/") + 1, -OBJECT_SUFFIX.length);

  return /^\d+$/.test(name) ? Number(name) : null;
}

export function contributionsPrefix(window: string): string {
  return `raw/contributions/${window}/`;
}

export function contributionsKey(window: string, fetchedAt: string): string {
  return `${contributionsPrefix(window)}${fetchedAt}${OBJECT_SUFFIX}`;
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
