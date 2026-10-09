// Rebuilds one file of an export from R2 without the export on hand, so a
// schema change replays the pages already archived.
import { mapConcurrent, OPEN_CONNECTIONS } from "../concurrency";
import { MissingRawObjectError } from "../normalize";
import type { ExportFile } from "./export";
import { APPLE_MUSIC_PREFIX, readPage } from "./import";

export interface AppleMusicReplay {
  pages: number;
  rowsChanged: number;
}

export async function replayAppleMusicFile(
  db: D1Database,
  bucket: R2Bucket,
  exportId: string,
  file: ExportFile,
): Promise<AppleMusicReplay> {
  const keys = await listKeys(bucket, `${APPLE_MUSIC_PREFIX}${exportId}/${file}/`);
  const pages = mapConcurrent(keys, OPEN_CONNECTIONS, async (key) => {
    const object = await bucket.get(key);
    if (object === null) {
      throw new MissingRawObjectError(key);
    }
    return readPage(file, await object.text());
  });
  // Reads land in key order and write one at a time, so a row two pages hold
  // keeps the later page's copy.
  let rowsChanged = 0;
  for await (const page of pages) {
    rowsChanged += await page.write(db, exportId);
  }
  return { pages: keys.length, rowsChanged };
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each listing needs the cursor the last one returned
    const listing = await bucket.list({ prefix, cursor });
    keys.push(...listing.objects.map((object) => object.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}
