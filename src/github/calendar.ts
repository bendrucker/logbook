// The contributions collection takes any `DateTime` bounds up to a year apart,
// so a window that dropped data narrows down the calendar: a year to quarters,
// a quarter to months, a month to days, a day to halves, and a half to hours.
// Each window's key names its prefix in R2 and its row in the crawl frontier.

import { Temporal } from "temporal-polyfill";
import { unhandled } from "../unhandled";
import {
  dayHalves,
  type HourRange,
  hourRangeEnd,
  hourRangeKey,
  parseDay,
  parseHourRange,
  parseYearMonth,
  splitHourRange,
  startsAfter,
  toUtc,
} from "./spans";

export interface ContributionsWindow {
  // `2015`, `2015-Q3`, `2015-07`, `2015-07-14`, or an hour range such as
  // `2015-07-14T00--2015-07-14T12`.
  key: string;
  from: Date;
  to: Date;
}

export class InvalidWindowError extends Error {
  constructor(value: string) {
    super(`${value} is not a contributions window`);
    this.name = "InvalidWindowError";
  }
}

type Span =
  | { unit: "year"; year: number }
  | { unit: "quarter"; year: number; quarter: number }
  | { unit: "month"; month: Temporal.PlainYearMonth }
  | { unit: "day"; day: Temporal.PlainDate }
  | HourRange;

function firstMonth(span: { year: number; quarter: number }): Temporal.PlainYearMonth {
  return Temporal.PlainYearMonth.from({ year: span.year, month: span.quarter * 3 - 2 });
}

function key(span: Span): string {
  switch (span.unit) {
    case "year":
      return String(span.year);
    case "quarter":
      return `${span.year}-Q${span.quarter}`;
    case "month":
      return span.month.toString();
    case "day":
      return span.day.toString();
    case "hours":
      return hourRangeKey(span);
    default:
      throw unhandled(span);
  }
}

function start(span: Span): Temporal.PlainDateTime {
  switch (span.unit) {
    case "year":
      return Temporal.PlainDateTime.from({ year: span.year, month: 1, day: 1 });
    case "quarter":
      return firstMonth(span).toPlainDate({ day: 1 }).toPlainDateTime();
    case "month":
      return span.month.toPlainDate({ day: 1 }).toPlainDateTime();
    case "day":
      return span.day.toPlainDateTime();
    case "hours":
      return span.start;
    default:
      throw unhandled(span);
  }
}

// The first instant after the window, which the next window at its level
// starts on.
function after(span: Span): Temporal.PlainDateTime {
  switch (span.unit) {
    case "year":
      return start(span).add({ years: 1 });
    case "quarter":
      return start(span).add({ months: 3 });
    case "month":
      return start(span).add({ months: 1 });
    case "day":
      return start(span).add({ days: 1 });
    case "hours":
      return hourRangeEnd(span);
    default:
      throw unhandled(span);
  }
}

function children(span: Span): Span[] {
  switch (span.unit) {
    case "year":
      return [1, 2, 3, 4].map((quarter) => ({ unit: "quarter", year: span.year, quarter }));
    case "quarter": {
      const first = firstMonth(span);
      return [0, 1, 2].map((offset) => ({ unit: "month", month: first.add({ months: offset }) }));
    }
    case "month":
      return Array.from({ length: span.month.daysInMonth }, (_, index) => ({
        unit: "day",
        day: span.month.toPlainDate({ day: index + 1 }),
      }));
    case "day":
      return dayHalves(span.day);
    case "hours":
      return splitHourRange(span);
    default:
      throw unhandled(span);
  }
}

// The collection rejects a window reaching into the future, so one still in
// progress stops at now. Bounds are inclusive, so a window ends a second before
// the next one starts.
function window(span: Span, now: Date): ContributionsWindow {
  const end = toUtc(after(span).subtract({ seconds: 1 }));
  return { key: key(span), from: toUtc(start(span)), to: now < end ? now : end };
}

function parse(value: string): Span | null {
  let match = /^(\d{4})$/.exec(value);
  if (match !== null) {
    return { unit: "year", year: Number(match[1]) };
  }

  match = /^(\d{4})-Q([1-4])$/.exec(value);
  if (match !== null) {
    return { unit: "quarter", year: Number(match[1]), quarter: Number(match[2]) };
  }

  const month = parseYearMonth(value);
  if (month !== null) {
    return { unit: "month", month };
  }

  const day = parseDay(value);
  if (day !== null) {
    return { unit: "day", day };
  }

  return parseHourRange(value);
}

function spanOf(value: string): Span {
  const span = parse(value);
  if (span === null) {
    throw new InvalidWindowError(value);
  }
  return span;
}

export function contributionsWindow(value: string, now: Date): ContributionsWindow {
  return window(spanOf(value), now);
}

export function yearWindow(year: number, now: Date): ContributionsWindow {
  return window({ unit: "year", year }, now);
}

// The narrower windows a truncated one is fetched again as. An hour has none.
export function splitContributions(value: string, now: Date): ContributionsWindow[] {
  return children(spanOf(value)).flatMap((child) =>
    startsAfter(start(child), now) ? [] : window(child, now),
  );
}

// A window narrower than a day counts only part of each day's commits, so its
// rows add up with its siblings' rather than standing alone.
export function enclosingDay(value: string): string | null {
  const span = parse(value);
  return span?.unit === "hours" ? span.start.toPlainDate().toString() : null;
}

// The cross-check compares a whole year's totals, so only a year window has
// one to compare.
export function windowYear(value: string): number | null {
  const span = parse(value);
  return span?.unit === "year" ? span.year : null;
}
