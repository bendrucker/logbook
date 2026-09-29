import { eachConcurrent, OPEN_CONNECTIONS } from "../concurrency";
import { failBuild, finishBuild, startBuild } from "./builds";
import { commitDays } from "./commit-days";
import { issues } from "./issues";
import { pullRequests } from "./pull-requests";
import { repositories } from "./repositories";
import { reviews } from "./reviews";
import { type EncodedTable, encodeTable, type LakeTable } from "./table";

export const LAKE_TABLES: readonly LakeTable[] = [
  repositories,
  pullRequests,
  reviews,
  issues,
  commitDays,
];

// Matches the nightly trigger in wrangler.jsonc. `scheduled` runs the sync on
// every other cron, so an expression that drifts from the config leaves the
// lake unbuilt and reports nothing.
//
// It lives here rather than beside the handler because workerd reads every
// named export of the entrypoint as a handler and refuses a string.
export const LAKE_CRON = "30 9 * * *";

// Activity Hub owns the bucket and writes its own tables under `lake/v1/`, so
// this project's prefix keeps one DuckDB session able to read both.
const PREFIX = "github/v1";

const CONTENT_TYPE = "application/vnd.apache.parquet";

export function tableKey(table: LakeTable): string {
  return `${PREFIX}/${table.name}/part-0.parquet`;
}

export interface LakeBuildResult {
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

    await eachConcurrent(encoded, OPEN_CONNECTIONS, (each) => writeTable(env.LAKE, each));

    const rowCounts = Object.fromEntries(encoded.map((each) => [each.table.name, each.rows]));
    const finishedAt = new Date().toISOString();
    await finishBuild(env.DB, id, rowCounts, finishedAt);

    return { startedAt, finishedAt, rowCounts };
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

function writeTable(bucket: R2Bucket, { table, buffer }: EncodedLakeTable): Promise<unknown> {
  return bucket.put(tableKey(table), buffer, { httpMetadata: { contentType: CONTENT_TYPE } });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
