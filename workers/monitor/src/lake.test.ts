import { describe, expect, it } from "vitest";
import { tableAges } from "./lake";

const now = new Date("2026-10-18T12:00:00Z");

describe("tableAges", () => {
  it("ages each table by its newest object", () => {
    expect(
      tableAges(
        [
          {
            key: "github/v1/pull_requests/part-0.parquet",
            uploaded: new Date("2026-10-18T09:30:00Z"),
          },
          { key: "github/v1/reviews/part-0.parquet", uploaded: new Date("2026-10-17T09:30:00Z") },
          { key: "github/v1/reviews/part-1.parquet", uploaded: new Date("2026-10-18T11:00:00Z") },
        ],
        now,
      ),
    ).toEqual([
      { table: "github/v1/pull_requests", ageSeconds: 9000 },
      { table: "github/v1/reviews", ageSeconds: 3600 },
    ]);
  });

  it("holds no tables for no objects", () => {
    expect(tableAges([], now)).toEqual([]);
  });
});
