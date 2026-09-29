import type { TraktKind } from "../sync/kinds";
import type { Pagination } from "./client";

// R2 lists lexicographically, so a page number is padded to keep one fetch's
// pages in the order they were read.
const PAGE_DIGITS = 4;

const OBJECT_SUFFIX = ".json";

export function traktPrefix(kind: TraktKind, window: string): string {
  return `raw/trakt/${kind}/${window}/`;
}

export function traktKey(kind: TraktKind, window: string, fetchedAt: string, page: number): string {
  const name = String(page).padStart(PAGE_DIGITS, "0");
  return `${traktPrefix(kind, window)}${fetchedAt}/${name}${OBJECT_SUFFIX}`;
}

export function traktPageNumber(key: string): number | null {
  const match = /\/(\d+)\.json$/.exec(key);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export interface TraktArchive {
  kind: TraktKind;
  window: string;
  fetchedAt: string;
  page: number;
  body: string;
  status: number;
  pagination: Pagination | null;
}

// A page's body is a bare array, and what says whether a fetch finished is the
// pagination Trakt sent in headers. Those ride along as custom metadata so the
// object stays the bytes as received.
export interface ArchivedMetadata {
  status: number;
  pagination: Pagination | null;
}

// Written once and never replaced: a rerun lands under a new fetch timestamp.
// A false return means the key was already there.
export async function archiveTraktPage(bucket: R2Bucket, archive: TraktArchive): Promise<boolean> {
  const { kind, window, fetchedAt, page, body, status, pagination } = archive;
  const written = await bucket.put(traktKey(kind, window, fetchedAt, page), body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      status: String(status),
      ...(pagination === null
        ? {}
        : {
            page: String(pagination.page),
            limit: String(pagination.limit),
            pageCount: String(pagination.pageCount),
            itemCount: String(pagination.itemCount),
          }),
    },
  });
  return written !== null;
}

export function readMetadata(metadata: Record<string, string> | undefined): ArchivedMetadata {
  const number = (name: string): number | null => {
    const value = Number(metadata?.[name] ?? Number.NaN);
    return Number.isInteger(value) ? value : null;
  };
  const [page, limit, pageCount, itemCount] = ["page", "limit", "pageCount", "itemCount"].map(
    number,
  );
  return {
    status: number("status") ?? 0,
    pagination:
      page == null || limit == null || pageCount == null || itemCount == null
        ? null
        : { page, limit, pageCount, itemCount },
  };
}
