// Re-normalizing reads R2 and never calls Trakt, so a schema change rebuilds
// the Trakt tables from the pages already archived.
import type { z } from "zod";
import { MissingRawObjectError, RawValidationError } from "../normalize";
import type { TraktKind } from "../sync/kinds";
import { readMetadata, traktPageNumber, traktPrefix } from "./raw";
import {
  addRows,
  normalizeHistory,
  normalizeRatings,
  type TraktRowsChanged,
  UNCHANGED,
} from "./rows";
import { historyPage, ratingsPage } from "./schema";

export interface TraktReplay {
  fetchedAt: string;
  // False when no fetch of the window finished, so the rebuild holds the pages
  // the newest fetch landed before it stopped.
  complete: boolean;
  rows: TraktRowsChanged;
}

interface ArchivedFetch {
  fetchedAt: string;
  // The pages Trakt answered 200 with a body that validated, in read order.
  pageKeys: string[];
  complete: boolean;
}

// Null means nothing is archived under the window.
export async function replayTraktWindow(
  db: D1Database,
  bucket: R2Bucket,
  kind: TraktKind,
  window: string,
): Promise<TraktReplay | null> {
  const prefix = traktPrefix(kind, window);
  const fetches = await listFetches(bucket, prefix);
  // A fetch timestamp is an ISO string, so the newest sorts last. A newer fetch
  // that stopped partway holds less of the window than an older one that
  // finished, and when none finished the newest is the most ever archived.
  const selected = fetches.findLast((fetch) => fetch.complete) ?? fetches.at(-1) ?? null;
  if (selected === null) {
    return null;
  }

  let rows = UNCHANGED;
  // One page after another, so a title two pages name keeps the later page's
  // copy.
  const pending = [...selected.pageKeys];
  let key = pending.shift();
  while (key !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const body = await readBody(bucket, key);
    // eslint-disable-next-line no-await-in-loop
    const changed = await normalizePage(db, kind, key, body, selected.fetchedAt);
    rows = addRows(rows, changed);
    key = pending.shift();
  }

  return { fetchedAt: selected.fetchedAt, complete: selected.complete, rows };
}

function normalizePage(
  db: D1Database,
  kind: TraktKind,
  key: string,
  body: string,
  fetchedAt: string,
): Promise<TraktRowsChanged> {
  switch (kind) {
    case "trakt-history":
      return normalizeHistory(db, parse(historyPage, key, body), fetchedAt);
    case "trakt-ratings":
      return normalizeRatings(db, parse(ratingsPage, key, body), fetchedAt);
  }
}

// A fetch finished when its pages run 1 to n without a gap, every one a 200
// that validated, and the last reports n pages. A page answered without pagination
// headers is the whole list on its own.
async function listFetches(bucket: R2Bucket, prefix: string): Promise<ArchivedFetch[]> {
  const byFetch = new Map<
    string,
    { key: string; metadata: Record<string, string> | undefined }[]
  >();
  let cursor: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop
    const listing = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    for (const object of listing.objects) {
      const fetchedAt = object.key.slice(prefix.length, object.key.lastIndexOf("/"));
      const objects = byFetch.get(fetchedAt) ?? [];
      objects.push({ key: object.key, metadata: object.customMetadata });
      byFetch.set(fetchedAt, objects);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);

  return [...byFetch.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([fetchedAt, objects]) => {
      const read = objects.map(({ key, metadata }) => ({ key, ...readMetadata(metadata) }));
      const answered = read.filter((object) => object.status === 200 && object.failure === null);
      const last = answered.at(-1);
      const contiguous =
        answered.length === read.length &&
        answered.every((object, index) => traktPageNumber(object.key) === index + 1);
      const reported = last?.pagination?.pageCount ?? 1;
      return {
        fetchedAt,
        pageKeys: answered.map((object) => object.key),
        complete: last !== undefined && contiguous && answered.length >= reported,
      };
    });
}

async function readBody(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (object === null) {
    throw new MissingRawObjectError(key);
  }
  return object.text();
}

function parse<T>(schema: z.ZodType<T>, key: string, body: string): T {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new RawValidationError(key, "the body is not JSON", error);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new RawValidationError(key, parsed.error.message, parsed.error);
  }
  return parsed.data;
}
