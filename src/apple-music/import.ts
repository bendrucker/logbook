import type { z } from "zod";
import { pageName, writeOnce } from "../raw-object";
import { EXPORT_FILES, type ExportFile } from "./export";
import {
  dailyTrackRow,
  favoriteRow,
  libraryTrackRow,
  likedRadioTrackRow,
  playRow,
  recordId,
} from "./rows";
import {
  dailyTrackRecord,
  favoriteRecord,
  libraryTrackRecord,
  likedRadioTrackRecord,
  playActivityRecord,
} from "./schema";
import { upsertDailyTracks, upsertLibraryTracks, upsertPlays, upsertPreferences } from "./store";

export const APPLE_MUSIC_PREFIX = "raw/apple-music/";

// An export is named for the day Apple produced it. Apple's export holds the
// whole history each time, so a newer one is a superset that lands beside the
// older one rather than over it.
const EXPORT_ID = /^\d{4}-\d{2}-\d{2}$/;

export function appleMusicKey(exportId: string, file: ExportFile, page: number): string {
  return `${APPLE_MUSIC_PREFIX}${exportId}/${file}/${pageName(page)}`;
}

export class ImportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRequestError";
  }
}

export class ImportConflictError extends Error {
  constructor(key: string) {
    super(`${key} is already archived with a different body`);
    this.name = "ImportConflictError";
  }
}

export interface ImportPage {
  exportId: string;
  file: ExportFile;
  page: number;
}

export function exportIdParam(params: URLSearchParams): string {
  const exportId = params.get("export") ?? "";
  if (!EXPORT_ID.test(exportId)) {
    throw new ImportRequestError("export must be the export's date, YYYY-MM-DD");
  }
  return exportId;
}

export function importPageRequest(params: URLSearchParams): ImportPage {
  const exportId = exportIdParam(params);
  const file = EXPORT_FILES.find((each) => each === params.get("file"));
  if (file === undefined) {
    throw new ImportRequestError(`file must be one of ${EXPORT_FILES.join(", ")}`);
  }
  const page = Number(params.get("page"));
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new ImportRequestError("page must be a positive integer");
  }
  return { exportId, file, page };
}

export interface ImportResult {
  key: string;
  // False when the page was already archived, as on a rerun of the same
  // export. The rows apply again either way.
  archived: boolean;
  records: number;
  rowsChanged: number;
}

// The page validates before it is archived, so everything under the prefix is
// a page `replayAppleMusic` can apply.
export async function importPage(
  env: Env,
  { exportId, file, page }: ImportPage,
  body: string,
): Promise<ImportResult> {
  const validated = readPage(file, body);
  const key = appleMusicKey(exportId, file, page);
  const archived = await writeOnce(env.RAW, key, body);
  // D1 must stay what a replay of R2 would write.
  if (!archived && (await archivedBody(env.RAW, key)) !== body) {
    throw new ImportConflictError(key);
  }
  const rowsChanged = await validated.write(env.DB, exportId);
  return { key, archived, records: validated.records, rowsChanged };
}

async function archivedBody(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  return object === null ? null : object.text();
}

export interface ValidatedPage {
  records: number;
  write: (db: D1Database, exportId: string) => Promise<number>;
}

export function readPage(file: ExportFile, body: string): ValidatedPage {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ImportRequestError("the body is not JSON");
  }
  return PAGES[file](file, data);
}

type PageReader = (file: ExportFile, data: unknown) => ValidatedPage;

function pageReader<Parsed>(
  record: z.ZodType<Parsed>,
  write: (db: D1Database, records: Parsed[], exportId: string) => Promise<number>,
): PageReader {
  return (file, data) => {
    const parsed = record.array().safeParse(data);
    if (!parsed.success) {
      throw new ImportRequestError(`the ${file} page did not validate: ${parsed.error.message}`);
    }
    return {
      records: parsed.data.length,
      write: (db, exportId) => write(db, parsed.data, exportId),
    };
  };
}

const PAGES: Record<ExportFile, PageReader> = {
  "play-activity": pageReader(playActivityRecord, (db, records) =>
    upsertPlays(db, present(records.map(playRow))),
  ),
  "daily-tracks": pageReader(dailyTrackRecord, async (db, records) =>
    upsertDailyTracks(
      db,
      await Promise.all(
        records.map(async (record) => dailyTrackRow(record, await recordId(record))),
      ),
    ),
  ),
  "library-tracks": pageReader(libraryTrackRecord, (db, records, exportId) =>
    upsertLibraryTracks(
      db,
      records.map((record) => libraryTrackRow(record, exportId)),
    ),
  ),
  favorites: pageReader(favoriteRecord, (db, records, exportId) =>
    upsertPreferences(db, present(records.map((record) => favoriteRow(record, exportId)))),
  ),
  "liked-radio-tracks": pageReader(likedRadioTrackRecord, (db, records, exportId) =>
    upsertPreferences(db, present(records.map((record) => likedRadioTrackRow(record, exportId)))),
  ),
};

function present<Row>(rows: readonly (Row | null)[]): Row[] {
  return rows.filter((row) => row !== null);
}
