import { OBJECT_SUFFIX, pageName, pageNumber, writeOnce } from "../raw-object";
import type { InstapaperKind } from "../sync/kinds";

export const RAW_PREFIX = "raw/instapaper/";

export function instapaperPrefix(kind: InstapaperKind, window: string): string {
  return `${RAW_PREFIX}${kind}/${window}/`;
}

export function instapaperKey(
  kind: InstapaperKind,
  window: string,
  fetchedAt: string,
  page: number,
): string {
  return `${instapaperPrefix(kind, window)}${fetchedAt}/${pageName(page)}`;
}

export interface InstapaperArchive {
  kind: InstapaperKind;
  window: string;
  fetchedAt: string;
  page: number;
  body: string;
  status: number;
  // The error that stopped the fetch at this page, since a body that failed
  // validation still arrived with a 200.
  failure?: string;
}

export interface ArchivedMetadata {
  status: number;
  failure: string | null;
}

// The status rides along as custom metadata so the object stays the bytes as
// received.
export function archiveInstapaperPage(
  bucket: R2Bucket,
  archive: InstapaperArchive,
): Promise<boolean> {
  const { kind, window, fetchedAt, page, body, status, failure } = archive;
  return writeOnce(bucket, instapaperKey(kind, window, fetchedAt, page), body, {
    status: String(status),
    ...(failure === undefined ? {} : { failure }),
  });
}

export function readMetadata(metadata: Record<string, string> | undefined): ArchivedMetadata {
  const status = Number(metadata?.status ?? Number.NaN);
  return {
    status: Number.isInteger(status) ? status : 0,
    failure: metadata?.failure ?? null,
  };
}

export interface ArchivedPage {
  key: string;
  kind: InstapaperKind;
  window: string;
  fetchedAt: string;
  page: number;
}

// Null for a key outside the layout `instapaperKey` writes.
export function parseKey(key: string): ArchivedPage | null {
  if (!key.startsWith(RAW_PREFIX) || !key.endsWith(OBJECT_SUFFIX)) {
    return null;
  }
  const [kind, window, fetchedAt, name] = key.slice(RAW_PREFIX.length).split("/");
  const page = pageNumber(key);
  if (
    (kind !== "instapaper-bookmarks" && kind !== "instapaper-highlights") ||
    window === undefined ||
    fetchedAt === undefined ||
    name === undefined ||
    page === null
  ) {
    return null;
  }
  return { key, kind, window, fetchedAt, page };
}
