export type BindValue = string | number | null;

export interface UpsertSpec<Column extends string> {
  table: string;
  columns: readonly Column[];
  conflict: readonly Column[];
  // Columns compared to decide whether the stored row changed. Defaults to every
  // column but the conflict key. One left out is still written when something
  // else moves, but never causes a write itself.
  compared?: readonly Column[];
  // Tables carrying a publish marker clear it on every change, which is what
  // returns the row to the publisher's queue.
  clearsPublishedAt?: boolean;
  // A column that only moves forward. A row carrying an older value than the
  // stored one is not written, so a late import of an older snapshot cannot
  // overwrite a newer one.
  monotonic?: Column;
}

// Every table here writes the same shape: insert the row, and on a key collision
// update it only when a stored column actually moved. An upsert matching what D1
// already holds writes no row at all, which is what keeps re-normalizing an
// archived R2 page from touching the database. The returned function answers how
// many rows its write actually changed.
export function upsertWriter<Row, Column extends string>(
  spec: UpsertSpec<Column>,
  bind: (row: Row) => Record<Column, BindValue>,
): (db: D1Database, rows: readonly Row[]) => Promise<number> {
  const sql = upsertSql(spec);
  return async (db, rows) => {
    if (rows.length === 0) {
      return 0;
    }
    const statement = db.prepare(sql);
    const results = await db.batch(
      rows.map((row) => {
        const values = bind(row);
        return statement.bind(...spec.columns.map((column) => values[column]));
      }),
    );
    return results.reduce((total, result) => total + result.meta.changes, 0);
  };
}

function upsertSql<Column extends string>(spec: UpsertSpec<Column>): string {
  const updated = spec.columns.filter((column) => !spec.conflict.includes(column));
  const placeholders = spec.columns.map((_, index) => `?${index + 1}`).join(", ");
  const assignments = updated.map((column) => `${column} = excluded.${column}`);
  if (spec.clearsPublishedAt) {
    assignments.push("published_at = NULL");
  }
  // IS NOT is SQLite's null-safe inequality. Plain != evaluates to unknown when
  // either side is null, which would read a column going null as unchanged.
  const changed = (spec.compared ?? updated)
    .map((column) => `${spec.table}.${column} IS NOT excluded.${column}`)
    .join(" OR ");
  const where =
    spec.monotonic === undefined
      ? changed
      : `(${changed}) AND ${spec.table}.${spec.monotonic} <= excluded.${spec.monotonic}`;
  return [
    `INSERT INTO ${spec.table} (${spec.columns.join(", ")})`,
    `VALUES (${placeholders})`,
    `ON CONFLICT (${spec.conflict.join(", ")}) DO UPDATE SET ${assignments.join(", ")}`,
    `WHERE ${where}`,
  ].join(" ");
}
