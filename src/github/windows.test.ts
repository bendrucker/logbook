import { describe, expect, it } from "vitest";
import {
  backfillSearch,
  createdWindow,
  incrementalSearch,
  InvalidSearchWindowError,
  monthlyWindows,
  monthWindow,
  splitCreatedWindow,
  splitUpdated,
} from "./windows";

describe("monthWindow", () => {
  it("ends February on the 29th in a leap year", () => {
    expect(monthWindow({ year: 2024, month: 2 })).toEqual({
      key: "2024-02",
      start: "2024-02-01",
      end: "2024-02-29",
      through: "2024-02-29T23:59:59.999Z",
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

    expect(windows).toMatchObject([{ key: "2026-09", start: "2026-09-01", end: "2026-09-30" }]);
  });

  it("returns nothing for a start month past now", () => {
    expect(monthlyWindows({ year: 2027, month: 1 }, new Date("2026-09-09T12:00:00Z"))).toEqual([]);
  });

  it("covers every month of the first year back to the first repository", () => {
    const windows = monthlyWindows({ year: 2012, month: 12 }, new Date("2026-09-09T12:00:00Z"));

    expect(windows[0]).toMatchObject({ key: "2012-12", start: "2012-12-01", end: "2012-12-31" });
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

  it("bounds an incremental run's update time on both ends", () => {
    const range = { since: "2026-09-09T11:00:00.000Z", until: "2026-09-09T12:00:00.000Z" };
    expect(incrementalSearch("pr-authored", "bendrucker", range)).toBe(
      "is:pr author:bendrucker updated:2026-09-09T11:00:00.000Z..2026-09-09T12:00:00.000Z",
    );
  });

  it("scopes a sub-day window on instants", () => {
    expect(
      backfillSearch("issue", "bendrucker", createdWindow("2026-08-14T12--2026-08-15T00")),
    ).toBe("is:issue author:bendrucker created:2026-08-14T12:00:00Z..2026-08-14T23:59:59Z");
  });
});

describe("createdWindow", () => {
  it("reads a day range with both ends inclusive", () => {
    expect(createdWindow("2026-08-01--2026-08-15")).toEqual({
      key: "2026-08-01--2026-08-15",
      start: "2026-08-01",
      end: "2026-08-15",
      through: "2026-08-15T23:59:59.999Z",
    });
  });

  it("reads a single day", () => {
    expect(createdWindow("2026-08-14")).toMatchObject({ start: "2026-08-14", end: "2026-08-14" });
  });

  it("reads an hour range up to the hour it stops before", () => {
    expect(createdWindow("2026-08-14T05--2026-08-14T06")).toEqual({
      key: "2026-08-14T05--2026-08-14T06",
      start: "2026-08-14T05:00:00Z",
      end: "2026-08-14T05:59:59Z",
      through: "2026-08-14T05:59:59.999Z",
    });
  });

  it.each([
    "2026",
    "2026-Q3",
    "2026-13",
    "2026-02-30",
    "2026-08-14--2026-08-14",
    "2026-08-15--2026-08-01",
    "2026-08-14T03--2026-08-14T15",
    "2026-08-14T00--2026-08-14T02",
  ])("rejects %s", (value) => {
    expect(() => createdWindow(value)).toThrow(InvalidSearchWindowError);
  });
});

describe("splitCreatedWindow", () => {
  const now = new Date("2026-09-27T00:00:00Z");

  it("halves a month into day ranges", () => {
    expect(splitCreatedWindow("2026-08", now)).toEqual([
      "2026-08-01--2026-08-15",
      "2026-08-16--2026-08-31",
    ]);
  });

  it("halves a day range down to single days", () => {
    expect(splitCreatedWindow("2026-08-01--2026-08-15", now)).toEqual([
      "2026-08-01--2026-08-07",
      "2026-08-08--2026-08-15",
    ]);
    expect(splitCreatedWindow("2026-08-14--2026-08-15", now)).toEqual(["2026-08-14", "2026-08-15"]);
  });

  it("splits a day into halves and a half into hours", () => {
    expect(splitCreatedWindow("2026-08-14", now)).toEqual([
      "2026-08-14T00--2026-08-14T12",
      "2026-08-14T12--2026-08-15T00",
    ]);
    expect(splitCreatedWindow("2026-08-14T12--2026-08-15T00", now)).toHaveLength(12);
  });

  it("leaves an hour irreducible", () => {
    expect(splitCreatedWindow("2026-08-14T05--2026-08-14T06", now)).toEqual([]);
  });

  it("leaves out a half yet to start", () => {
    expect(splitCreatedWindow("2026-09", new Date("2026-09-09T12:00:00Z"))).toEqual([
      "2026-09-01--2026-09-15",
    ]);
  });

  it("names children that parse back to themselves", () => {
    const keys = splitCreatedWindow("2026-08-01--2026-08-03", now);
    expect(keys.map((key) => createdWindow(key).key)).toEqual(keys);
  });
});

describe("splitUpdated", () => {
  it("halves a range at its midpoint, sharing the middle second", () => {
    expect(
      splitUpdated({ since: "2026-09-01T00:00:00.000Z", until: "2026-09-09T00:00:00.000Z" }),
    ).toEqual([
      { since: "2026-09-01T00:00:00.000Z", until: "2026-09-05T00:00:00.000Z" },
      { since: "2026-09-05T00:00:00.000Z", until: "2026-09-09T00:00:00.000Z" },
    ]);
  });

  it("splits on a whole second", () => {
    const [first] = splitUpdated({
      since: "2026-09-01T00:00:00.500Z",
      until: "2026-09-01T00:00:03.250Z",
    });
    expect(first?.until).toBe("2026-09-01T00:00:01.000Z");
  });

  it("leaves a range a second wide whole", () => {
    expect(
      splitUpdated({ since: "2026-09-01T00:00:00.000Z", until: "2026-09-01T00:00:01.000Z" }),
    ).toEqual([]);
  });
});
