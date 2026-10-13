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

    // Every write settles before a failure is acted on, so none lands after
    // the discard. Nothing is pruned yet, so the previous build is whole under
    // every table, and deleting what this one wrote leaves readers on it alone.
    const unwritten = await settleEach(
      encoded,
      (each) => each.table,
      (each) => writeTable(env.LAKE, id, each),
    );
    if (unwritten.length > 0) {
      await discardBuild(env.LAKE, id).catch(() => undefined);
      throw new Error(`write failed for ${unwritten.join("; ")}`);
    }

    // Earlier builds go only once every table has its new file, so a reader
    // globbing a prefix sees two builds for a moment rather than none. Every
    // table's prune runs even when one fails, so one failed delete leaves one
    // table doubled rather than every table after it.
    const unpruned = await settleEach(
      LAKE_TABLES,
      (table) => table,
      (table) => pruneTable(env.LAKE, table, id),
    );
    if (unpruned.length > 0) {
      throw new Error(`prune failed for ${unpruned.join("; ")}`);
    }

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

function discardBuild(bucket: R2Bucket, build: number): Promise<void> {
  return bucket.delete(LAKE_TABLES.map((table) => tableKey(table, build)));
}

// Runs `run` over every item, at most `OPEN_CONNECTIONS` at once, and waits for
// all of them. Answers each failure as its table's name and error.
async function settleEach<T>(
  items: readonly T[],
  tableOf: (item: T) => LakeTable,
  run: (item: T) => Promise<unknown>,
): Promise<string[]> {
  const failures: string[] = [];
  await eachConcurrent(items, OPEN_CONNECTIONS, (item) =>
    run(item).catch((error: unknown) => {
      failures.push(`${tableOf(item).name}: ${message(error)}`);
    }),
  );
  return failures;
}

// R2 deletes at most this many keys per call, the same as a list page.
const DELETE_BATCH = 1000;

// Keeps the newest build's file under the table and deletes the rest, which
// includes the unversioned `part-0.parquet` builds wrote before build keys.
// Keeping the newest rather than this build's own means two builds that
// overlap, the nightly cron and an admin rebuild, settle on the same file
// whichever prunes last, rather than each deleting the other's.
async function pruneTable(bucket: R2Bucket, table: LakeTable, build: number): Promise<void> {
  const keys = await listKeys(bucket, `${table.path}/`);
  const newest = Math.max(build, ...keys.map(buildOf));
  const stale = keys.filter((key) => buildOf(key) !== newest);

  for (let start = 0; start < stale.length; start += DELETE_BATCH) {
    // oxlint-disable-next-line no-await-in-loop -- R2 caps keys per delete
    await bucket.delete(stale.slice(start, start + DELETE_BATCH));
  }
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    // oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
    const listed = await bucket.list({ prefix, cursor });
    keys.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);

  return keys;
}

const BUILD_SEGMENT = /\/build=(\d+)\/[^/]+$/;

// The build a key belongs to, or -1 for a key no build wrote, which then never
// counts as newest.
function buildOf(key: string): number {
  const match = BUILD_SEGMENT.exec(key);
  return match?.[1] === undefined ? -1 : Number(match[1]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
