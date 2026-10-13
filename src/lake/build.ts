import { eachConcurrent, OPEN_CONNECTIONS } from "../concurrency";
import { failBuild, finishBuild, startBuild } from "./builds";
import { commitDays } from "./commit-days";
import { instapaperBookmarks, instapaperFolders, instapaperHighlights } from "./instapaper";
import { issues } from "./issues";
import {
  appleMusicDailyTracks,
  appleMusicLibraryTracks,
  appleMusicPreferences,
  musicPlays,
  musicTracks,
} from "./music";
import { pullRequests } from "./pull-requests";
import { repositories } from "./repositories";
import { reviews } from "./reviews";
import { type EncodedTable, encodeTable, type LakeTable } from "./table";
import { traktPlays, traktRatings, traktTitles } from "./trakt";

export const LAKE_TABLES: readonly LakeTable[] = [
  repositories,
  pullRequests,
  reviews,
  issues,
  commitDays,
  instapaperBookmarks,
  instapaperHighlights,
  instapaperFolders,
  traktTitles,
  traktPlays,
  traktRatings,
  musicPlays,
  musicTracks,
  appleMusicDailyTracks,
  appleMusicLibraryTracks,
  appleMusicPreferences,
];

// Matches the nightly trigger in wrangler.jsonc. `scheduled` runs the sync on
// every other cron, so an expression that drifts from the config leaves the
// lake unbuilt and reports nothing.
//
// It lives here rather than beside the handler because workerd reads every
// named export of the entrypoint as a handler and refuses a string.
export const LAKE_CRON = "30 9 * * *";

const CONTENT_TYPE = "application/vnd.apache.parquet";

// Activity Hub owns the bucket and writes its own tables under `lake/v1/`, so
// each source's own prefix keeps one DuckDB session able to read them all. A
// build writes new keys rather than overwriting, so a catalog can later register
// each file as written instead of copying it.
export function tableKey(table: LakeTable, build: number): string {
  return `${table.path}/build=${build}/part-0.parquet`;
}

export interface LakeBuildResult {
  id: number;
  startedAt: string;
  finishedAt: string;
  rowCounts: Record<string, number>;
}

// A full rebuild rather than an incremental merge, which the corpus size makes
// affordable and which keeps a schema change a rerun rather than a migration.
export async function buildLake(
  env: Env,
  startedAt: string = new Date().toISOString(),
): Promise<LakeBuildResult> {
  const id = await startBuild(env.DB, startedAt);

  try {
    // Every table encodes before any is written, so a table that throws leaves
    // the bucket on the last complete build rather than mixing a rebuilt table
    // with a stale one that a reader joining them could not tell apart. They
    // encode one at a time, so only one table's rows are held beside the
    // compressed files already built.
    const encoded: EncodedLakeTable[] = [];
    for (const table of LAKE_TABLES) {
      // oxlint-disable-next-line no-await-in-loop -- one table's rows in memory at a time
      encoded.push(await encodeOne(env.DB, table));
    }

    await eachConcurrent(encoded, OPEN_CONNECTIONS, (each) => writeTable(env.LAKE, id, each));

    // Earlier builds go only once every table has its new file, so a reader
    // globbing a prefix sees two builds for a moment rather than none.
    await eachConcurrent(LAKE_TABLES, OPEN_CONNECTIONS, (table) => pruneTable(env.LAKE, table, id));

    const rowCounts = Object.fromEntries(encoded.map((each) => [each.table.name, each.rows]));
    const finishedAt = new Date().toISOString();
    await finishBuild(env.DB, id, rowCounts, finishedAt);

    return { id, startedAt, finishedAt, rowCounts };
  } catch (error) {
    await failBuild(env.DB, id, message(error), new Date().toISOString());
    throw error;
  }
}

interface EncodedLakeTable extends EncodedTable {
  table: LakeTable;
}

async function encodeOne(db: D1Database, table: LakeTable): Promise<EncodedLakeTable> {
  return { table, ...(await encodeTable(db, table)) };
}

function writeTable(
  bucket: R2Bucket,
  build: number,
  { table, buffer }: EncodedLakeTable,
): Promise<unknown> {
  return bucket.put(tableKey(table, build), buffer, {
    httpMetadata: { contentType: CONTENT_TYPE },
  });
}

// Deletes everything under the table's prefix but this build's file, which
// includes the unversioned `part-0.parquet` builds wrote before build keys.
async function pruneTable(bucket: R2Bucket, table: LakeTable, build: number): Promise<void> {
  const keep = tableKey(table, build);
  let cursor: string | undefined;

  do {
    // oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
    const listed = await bucket.list({ prefix: `${table.path}/`, cursor });
    const stale = listed.objects.map((object) => object.key).filter((key) => key !== keep);
    if (stale.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- one page's deletes before the next list
      await bucket.delete(stale);
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
