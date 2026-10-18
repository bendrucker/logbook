// The prefixes logbook publishes to the shared lake. A table is a directory
// beneath one, whatever files the build writes into it, so a table added to
// the build is probed without a change here.
export const LAKE_PREFIXES = ["github/v1/", "trakt/v1/", "instapaper/v1/", "music/v1/"];

// The nightly build rewrites every table, so one older than a day and a
// couple of hours is a build that didn't land.
export const LAKE_MAX_AGE_SECONDS = 26 * 3600;

export interface LakeObject {
  key: string;
  uploaded: Date;
}

export interface TableAge {
  table: string;
  ageSeconds: number;
}

export async function listObjects(bucket: R2Bucket, prefix: string): Promise<LakeObject[]> {
  const objects: LakeObject[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
    const page = await bucket.list({ prefix, cursor });
    objects.push(...page.objects.map(({ key, uploaded }) => ({ key, uploaded })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
}

// A table's age is its newest object's, since a build that wrote any file of
// it wrote the table.
export function tableAges(objects: LakeObject[], now: Date): TableAge[] {
  const newest = new Map<string, number>();
  for (const { key, uploaded } of objects) {
    const table = key.slice(0, key.lastIndexOf("/"));
    newest.set(table, Math.max(newest.get(table) ?? 0, uploaded.getTime()));
  }
  return [...newest]
    .map(([table, at]) => ({ table, ageSeconds: Math.round((now.getTime() - at) / 1000) }))
    .toSorted((a, b) => a.table.localeCompare(b.table));
}
