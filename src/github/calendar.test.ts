import { describe, expect, it } from "vitest";
import {
  contributionsWindow,
  enclosingDay,
  InvalidWindowError,
  splitContributions,
  windowYear,
} from "./calendar";

const NOW = new Date("2026-09-09T12:00:00Z");

function bounds(key: string, now = NOW) {
  return splitContributions(key, now).map(({ key: child, from, to }) => ({
    key: child,
    from: from.toISOString(),
    to: to.toISOString(),
  }));
}

describe("splitContributions", () => {
  it("splits a past year into four quarters that meet end to end", () => {
    expect(bounds("2025")).toEqual([
      { key: "2025-Q1", from: "2025-01-01T00:00:00.000Z", to: "2025-03-31T23:59:59.000Z" },
      { key: "2025-Q2", from: "2025-04-01T00:00:00.000Z", to: "2025-06-30T23:59:59.000Z" },
      { key: "2025-Q3", from: "2025-07-01T00:00:00.000Z", to: "2025-09-30T23:59:59.000Z" },
      { key: "2025-Q4", from: "2025-10-01T00:00:00.000Z", to: "2025-12-31T23:59:59.000Z" },
    ]);
  });

  it("stops the current year at now and leaves out quarters yet to start", () => {
    expect(bounds("2026").at(-1)).toEqual({
      key: "2026-Q3",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-09-09T12:00:00.000Z",
    });
    expect(bounds("2026")).toHaveLength(3);
  });

  it("splits a quarter into its months", () => {
    expect(bounds("2015-Q3").map(({ key }) => key)).toEqual(["2015-07", "2015-08", "2015-09"]);
  });

  it("splits a month into its days, ending on the month's last", () => {
    const days = bounds("2016-02");

    expect(days).toHaveLength(29);
    expect(days.at(-1)).toEqual({
      key: "2016-02-29",
      from: "2016-02-29T00:00:00.000Z",
      to: "2016-02-29T23:59:59.000Z",
    });
  });

  it("splits a day into halves and a half into hours", () => {
    expect(bounds("2015-07-14")).toEqual([
      {
        key: "2015-07-14T00--2015-07-14T12",
        from: "2015-07-14T00:00:00.000Z",
        to: "2015-07-14T11:59:59.000Z",
      },
      {
        key: "2015-07-14T12--2015-07-15T00",
        from: "2015-07-14T12:00:00.000Z",
        to: "2015-07-14T23:59:59.000Z",
      },
    ]);
    expect(bounds("2015-07-14T12--2015-07-15T00").map(({ key }) => key)).toHaveLength(12);
    expect(bounds("2015-07-14T12--2015-07-15T00").at(-1)?.key).toBe("2015-07-14T23--2015-07-15T00");
  });

  it("has nothing narrower than an hour", () => {
    expect(bounds("2015-07-14T03--2015-07-14T04")).toEqual([]);
  });

  it("names each child with a key that parses back to the same window", () => {
    const keys = ["2015", "2015-Q3", "2015-07", "2015-07-14", "2015-07-14T00--2015-07-14T12"];
    for (const key of keys) {
      for (const child of splitContributions(key, NOW)) {
        expect(contributionsWindow(child.key, NOW)).toEqual(child);
      }
    }
  });
});

describe("contributionsWindow", () => {
  it.each([
    "15",
    "2015-Q5",
    "2015-13",
    "2015-02-30",
    "2015-02-29",
    "2015-07-14T00--2015-07-14T05",
    "2015-07-14T12--2015-07-14T24",
    "2015-07-14T06--2015-07-14T18",
  ])("rejects %s", (key) => {
    expect(() => contributionsWindow(key, NOW)).toThrow(InvalidWindowError);
  });
});

describe("contributionsWindow on a leap day", () => {
  it("reads the day and its halves", () => {
    expect(contributionsWindow("2016-02-29", NOW)).toEqual({
      key: "2016-02-29",
      from: new Date("2016-02-29T00:00:00Z"),
      to: new Date("2016-02-29T23:59:59Z"),
    });
    expect(bounds("2016-02-29").at(-1)?.key).toBe("2016-02-29T12--2016-03-01T00");
  });
});

describe("enclosingDay", () => {
  it("names the day an hour range falls in", () => {
    expect(enclosingDay("2015-07-14T12--2015-07-15T00")).toBe("2015-07-14");
    expect(enclosingDay("2015-07-14")).toBeNull();
    expect(enclosingDay("2015")).toBeNull();
  });
});

describe("windowYear", () => {
  it("reads the year off a year window only", () => {
    expect(windowYear("2015")).toBe(2015);
    expect(windowYear("2015-Q3")).toBeNull();
  });
});
