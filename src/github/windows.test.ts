import { describe, expect, it } from "vitest";
import { backfillSearch, incrementalSearch, monthlyWindows, monthWindow } from "./windows";

describe("monthWindow", () => {
  it("ends February on the 29th in a leap year", () => {
    expect(monthWindow({ year: 2024, month: 2 })).toEqual({
      key: "2024-02",
      start: "2024-02-01",
      end: "2024-02-29",
    });
  });

  it("ends February on the 28th outside one", () => {
    expect(monthWindow({ year: 2026, month: 2 }).end).toBe("2026-02-28");
  });

  it("ends a thirty-day month on the 30th", () => {
    expect(monthWindow({ year: 2026, month: 4 }).end).toBe("2026-04-30");
  });

  it("ends a thirty-one-day month on the 31st", () => {
    expect(monthWindow({ year: 2026, month: 12 }).end).toBe("2026-12-31");
  });

  it("pads a single-digit month", () => {
    expect(monthWindow({ year: 2026, month: 9 }).key).toBe("2026-09");
  });
});

describe("monthlyWindows", () => {
  it("runs from the start month through the month holding now", () => {
    const windows = monthlyWindows({ year: 2026, month: 7 }, new Date("2026-09-09T12:00:00Z"));

    expect(windows.map((window) => window.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("crosses a year boundary", () => {
    const windows = monthlyWindows({ year: 2025, month: 11 }, new Date("2026-01-15T00:00:00Z"));

    expect(windows.map((window) => window.key)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("returns a single window when the start month is the current one", () => {
    const windows = monthlyWindows({ year: 2026, month: 9 }, new Date("2026-09-09T12:00:00Z"));

    expect(windows).toEqual([{ key: "2026-09", start: "2026-09-01", end: "2026-09-30" }]);
  });

  it("returns nothing for a start month past now", () => {
    expect(monthlyWindows({ year: 2027, month: 1 }, new Date("2026-09-09T12:00:00Z"))).toEqual([]);
  });

  it("covers every month of the first year back to the first repository", () => {
    const windows = monthlyWindows({ year: 2012, month: 12 }, new Date("2026-09-09T12:00:00Z"));

    expect(windows[0]).toEqual({ key: "2012-12", start: "2012-12-01", end: "2012-12-31" });
    expect(windows.at(-1)?.key).toBe("2026-09");
  });
});

describe("search strings", () => {
  const window = monthWindow({ year: 2024, month: 2 });

  it("scopes a backfill window to authored pull requests", () => {
    expect(backfillSearch("pr-authored", "bendrucker", window)).toBe(
      "is:pr author:bendrucker created:2024-02-01..2024-02-29",
    );
  });

  it("scopes a backfill window to pull requests someone else authored", () => {
    expect(backfillSearch("pr-reviewed", "bendrucker", window)).toBe(
      "is:pr reviewed-by:bendrucker -author:bendrucker created:2024-02-01..2024-02-29",
    );
  });

  it("scopes a backfill window to authored issues", () => {
    expect(backfillSearch("issue", "bendrucker", window)).toBe(
      "is:issue author:bendrucker created:2024-02-01..2024-02-29",
    );
  });

  it("scopes an incremental run on update time", () => {
    expect(incrementalSearch("pr-authored", "bendrucker", "2026-09-09T11:00:00Z")).toBe(
      "is:pr author:bendrucker updated:>2026-09-09T11:00:00Z",
    );
  });
});
