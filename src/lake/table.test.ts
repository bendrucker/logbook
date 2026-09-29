import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pullRequest, seedRepository } from "../../test/fixtures";
import { parquetCodecs, parquetColumns, parquetRows, readParquet } from "../../test/parquet";
import { upsertPullRequests } from "../store";
import { pullRequests } from "./pull-requests";
import { encodeTable, readRows } from "./table";

const PAGE_SIZE = 1000;

function manyPullRequests(count: number) {
  return Array.from({ length: count }, (_, index) =>
    pullRequest({ id: `PR_${String(index).padStart(5, "0")}`, number: index }),
  );
}

describe("readRows", () => {
  beforeEach(() => seedRepository(env.DB));

  it("reads a table that fits in one page", async () => {
    await upsertPullRequests(env.DB, manyPullRequests(3));

    expect(await readRows(env.DB, pullRequests)).toHaveLength(3);
  });

  it("reads a table longer than one page without repeating or skipping a row", async () => {
    await upsertPullRequests(env.DB, manyPullRequests(PAGE_SIZE + 7));

    const rows = await readRows(env.DB, pullRequests);
    const ids = new Set(rows.map((row) => row.id));

    expect(rows).toHaveLength(PAGE_SIZE + 7);
    expect(ids.size).toBe(PAGE_SIZE + 7);
  });

  it("reads an empty table", async () => {
    expect(await readRows(env.DB, pullRequests)).toEqual([]);
  });

  it("refuses a table that pages by a column it does not select", async () => {
    const table = { ...pullRequests, key: ["published_at"] };

    await expect(readRows(env.DB, table)).rejects.toThrow("published_at");
  });

  it("leaves the publish marker out of the lake", async () => {
    await upsertPullRequests(env.DB, [pullRequest()]);

    const [row] = await readRows(env.DB, pullRequests);

    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("published_at");
  });
});

describe("encodeTable", () => {
  beforeEach(() => seedRepository(env.DB));

  it("writes the column names D1 uses", async () => {
    await upsertPullRequests(env.DB, [pullRequest()]);

    const { buffer } = await encodeTable(env.DB, pullRequests);

    expect(parquetColumns(buffer)).toEqual(pullRequests.columns.map((column) => column.name));
  });

  it("compresses with a codec the reader supports", async () => {
    await upsertPullRequests(env.DB, manyPullRequests(50));

    const { buffer } = await encodeTable(env.DB, pullRequests);

    expect(new Set(parquetCodecs(buffer))).toEqual(new Set(["SNAPPY"]));
    await expect(readParquet(buffer)).resolves.toHaveLength(50);
  });

  it("counts the rows it encoded", async () => {
    await upsertPullRequests(env.DB, manyPullRequests(12));

    const { buffer, rows } = await encodeTable(env.DB, pullRequests);

    expect(rows).toBe(12);
    expect(parquetRows(buffer)).toBe(12);
  });

  it("encodes an empty table as a readable file with no rows", async () => {
    const { buffer, rows } = await encodeTable(env.DB, pullRequests);

    expect(rows).toBe(0);
    expect(parquetRows(buffer)).toBe(0);
    await expect(readParquet(buffer)).resolves.toEqual([]);
  });
});
