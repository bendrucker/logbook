import { pageName, writeOnce } from "../raw-object";
import type { TraktKind } from "../sync/kinds";
import type { Pagination } from "./client";

export function traktPrefix(kind: TraktKind, window: string): string {
  return `raw/trakt/${kind}/${window}/`;
}

export function traktKey(kind: TraktKind, window: string, fetchedAt: string, page: number): string {
  return `${traktPrefix(kind, window)}${fetchedAt}/${pageName(page)}`;
}

export interface TraktArchive {
  kind: TraktKind;
  window: string;
  fetchedAt: string;
  page: number;
  body: string;
  status: number;
  pagination: Pagination | null;
  // The error that stopped the fetch at this page, since a body that failed
  // validation still arrived with a 200.
  failure?: string;
}

// A page's body is a bare array, and what says whether a fetch finished is the
// pagination Trakt sent in headers. Those ride along as custom metadata so the
// object stays the bytes as received.
export interface ArchivedMetadata {
  status: number;
  pagination: Pagination | null;
  failure: string | null;
}

export function archiveTraktPage(bucket: R2Bucket, archive: TraktArchive): Promise<boolean> {
  const { kind, window, fetchedAt, page, body, status, pagination, failure } = archive;
  return writeOnce(bucket, traktKey(kind, window, fetchedAt, page), body, {
    status: String(status),
    ...(failure === undefined ? {} : { failure }),
    ...(pagination === null
      ? {}
      : { page: String(pagination.page), pageCount: String(pagination.pageCount) }),
  });
}

export function readMetadata(metadata: Record<string, string> | undefined): ArchivedMetadata {
  const number = (name: string): number | null => {
    const value = Number(metadata?.[name] ?? Number.NaN);
    return Number.isInteger(value) ? value : null;
  };
  const page = number("page");
  const pageCount = number("pageCount");
  return {
    status: number("status") ?? 0,
    failure: metadata?.failure ?? null,
    pagination: page === null || pageCount === null ? null : { page, pageCount },
  };
}
