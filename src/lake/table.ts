import { parquetWriteBuffer } from "hyparquet-writer";
import type { LakeColumn } from "./columns";

export interface LakeTable {
  name: string;
  // Where the Parquet lands in the lake bucket: the source's prefix, a schema
  // version, and the table.
  path: string;
  // Ordering for the paged read, which has to be total so no row is read twice
  // or skipped as pages advance. Every key column is also a `columns` entry,
  // since the page after this one starts from the last row's key.
  key: readonly string[];
  columns: readonly LakeColumn[];
}

// D1 answers one statement comfortably in the low thousands of rows, and the
// corpus is tens of thousands, so a table reads as a handful of pages rather
// than one statement that would be refused at some size nothing here checks.
const PAGE_SIZE = 1000;

// Requesting ZSTD does not fail. The writer records the codec and stores the
// page uncompressed, and nothing can read that file back, so the codec is named
// here rather than left to a default that a later edit could change.
const CODEC = "SNAPPY";

export interface EncodedTable {
  buffer: ArrayBuffer;
  rows: number;
}

export async function encodeTable(db: D1Database, table: LakeTable): Promise<EncodedTable> {
  const rows = await readRows(db, table);

  const buffer = parquetWriteBuffer({
    codec: CODEC,
    columnData: table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      data: rows.map((row) => column.cell(row[column.name])),
    })),
  });

  return { buffer, rows: rows.length };
}

// Each page starts from the last row's key rather than an offset. An offset
// counts rows the sync may have inserted ahead of it between pages, which reads
// a row twice or skips one, and it makes D1 walk the rows it already returned.
export async function readRows(
  db: D1Database,
  table: LakeTable,
): Promise<Record<string, unknown>[]> {
  const selected = new Set(table.columns.map((column) => column.name));
  const missing = table.key.filter((name) => !selected.has(name));
  if (missing.length > 0) {
    // A key column the select leaves out reads back undefined, which binds as
    // NULL, matches no row, and ends the read early with the table truncated.
    throw new Error(`${table.name} pages by ${missing.join(", ")}, which it does not select`);
  }

  const names = table.columns.map((column) => column.name).join(", ");
  const key = table.key.join(", ");
  const tail = ` ORDER BY ${key} LIMIT ${PAGE_SIZE}`;
  const first = db.prepare(`SELECT ${names} FROM ${table.name}${tail}`);
  const after = db.prepare(
    `SELECT ${names} FROM ${table.name}` +
      ` WHERE (${key}) > (${table.key.map((_, index) => `?${index + 1}`).join(", ")})${tail}`,
  );

  const rows: Record<string, unknown>[] = [];
  let page: Record<string, unknown>[];
  let cursor: unknown[] | null = null;

  do {
    const statement = cursor === null ? first : after.bind(...cursor);
    // oxlint-disable-next-line no-await-in-loop -- each query needs the previous page's last key
    const result = await statement.all();
    page = result.results;
    rows.push(...page);

    const last = page.at(-1);
    cursor = last === undefined ? null : table.key.map((name) => last[name]);
  } while (page.length === PAGE_SIZE);

  return rows;
}
