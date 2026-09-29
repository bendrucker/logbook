// Re-normalizing reads R2 and never calls Instapaper, so a schema change
// rebuilds the Instapaper tables from the pages already archived.
import type { z } from "zod";
import { MissingRawObjectError, RawValidationError } from "../normalize";
import { type ArchivedPage, parseKey, RAW_PREFIX, readMetadata } from "./raw";
import { applyChanges, applyFolders, applyHighlights } from "./rows";
import { changesResponse, foldersResponse, highlightsResponse } from "./schema";
import { CHANGES_WINDOW, FOLDERS_WINDOW } from "./sync";

export interface InstapaperReplay {
  pages: number;
  rowsChanged: number;
}

// A deletion on one page can name a bookmark an earlier page upserted, so the
// pages apply in the order they arrived, which is the order of their runs'
// fetch times.
export async function replayInstapaper(
  db: D1Database,
  bucket: R2Bucket,
): Promise<InstapaperReplay> {
  const pages = await listReplayable(bucket);
  let rowsChanged = 0;

  for (const page of pages) {
    // oxlint-disable-next-line no-await-in-loop -- pages apply in fetch order
    rowsChanged += await replayPage(db, page, await readBody(bucket, page.key));
  }

  return { pages: pages.length, rowsChanged };
}

async function replayPage(db: D1Database, page: ArchivedPage, body: string): Promise<number> {
  const data = parseJson(page.key, body);
  if (page.kind === "instapaper-highlights") {
    const { highlights } = validate(highlightsResponse, page.key, data);
    return applyHighlights(db, Number(page.window), highlights);
  }
  switch (page.window) {
    case FOLDERS_WINDOW:
      return applyFolders(db, validate(foldersResponse, page.key, data).folders, page.fetchedAt);
    case CHANGES_WINDOW:
      return applyChanges(db, validate(changesResponse, page.key, data), page.fetchedAt);
    default:
      throw new RawValidationError(page.key, "the key names no bookmarks window", null);
  }
}

// A page archived as the failure that stopped its run never reached D1.
async function listReplayable(bucket: R2Bucket): Promise<ArchivedPage[]> {
  const pages: ArchivedPage[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each listing names the next cursor
    const listed = await bucket.list({ prefix: RAW_PREFIX, cursor, include: ["customMetadata"] });
    for (const object of listed.objects) {
      const page = parseKey(object.key);
      if (page !== null && readMetadata(object.customMetadata).failure === null) {
        pages.push(page);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);

  return pages.toSorted(
    (a, b) =>
      [
        a.fetchedAt.localeCompare(b.fetchedAt),
        a.kind.localeCompare(b.kind),
        a.window.localeCompare(b.window),
        a.page - b.page,
      ].find((order) => order !== 0) ?? 0,
  );
}

async function readBody(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (object === null) {
    throw new MissingRawObjectError(key);
  }
  return object.text();
}

function parseJson(key: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new RawValidationError(key, "the body is not JSON", error);
  }
}

function validate<T>(schema: z.ZodType<T>, key: string, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new RawValidationError(key, parsed.error.message, parsed.error);
  }
  return parsed.data;
}
