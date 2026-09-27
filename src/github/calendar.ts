// The contributions collection takes any `DateTime` bounds up to a year apart,
// so a window that dropped data narrows down the calendar: a year to quarters,
// a quarter to months, a month to days, a day to halves, and a half to hours.
// Each window's key names its prefix in R2 and its row in the crawl frontier.

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

const HOUR_MS = 60 * 60 * 1000;

// A day splits into halves and a half into hours. An hour is the finest window,
// so one still truncated there is irreducible.
const HALF_DAY_HOURS = 12;

type Span =
  | { unit: "year"; year: number }
  | { unit: "quarter"; year: number; quarter: number }
  | { unit: "month"; year: number; month: number }
  | { unit: "day"; start: Date }
  | { unit: "hours"; start: Date; hours: number };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, "2015-07-14".length);
}

function hourKey(date: Date): string {
  return date.toISOString().slice(0, "2015-07-14T00".length);
}

function key(span: Span): string {
  switch (span.unit) {
    case "year":
      return String(span.year);
    case "quarter":
      return `${span.year}-Q${span.quarter}`;
    case "month":
      return `${span.year}-${pad(span.month)}`;
    case "day":
      return dayKey(span.start);
    case "hours":
      return `${hourKey(span.start)}--${hourKey(new Date(span.start.getTime() + span.hours * HOUR_MS))}`;
  }
}

function start(span: Span): Date {
  switch (span.unit) {
    case "year":
      return new Date(Date.UTC(span.year, 0, 1));
    case "quarter":
      return new Date(Date.UTC(span.year, (span.quarter - 1) * 3, 1));
    case "month":
      return new Date(Date.UTC(span.year, span.month - 1, 1));
    case "day":
    case "hours":
      return span.start;
  }
}

// The first instant after the window, which the next window at its level
// starts on.
function after(span: Span): Date {
  switch (span.unit) {
    case "year":
      return new Date(Date.UTC(span.year + 1, 0, 1));
    case "quarter":
      return new Date(Date.UTC(span.year, span.quarter * 3, 1));
    case "month":
      return new Date(Date.UTC(span.year, span.month, 1));
    case "day":
      return new Date(span.start.getTime() + 24 * HOUR_MS);
    case "hours":
      return new Date(span.start.getTime() + span.hours * HOUR_MS);
  }
}

function children(span: Span): Span[] {
  switch (span.unit) {
    case "year":
      return [1, 2, 3, 4].map((quarter) => ({ unit: "quarter", year: span.year, quarter }));
    case "quarter":
      return [1, 2, 3].map((offset) => ({
        unit: "month",
        year: span.year,
        month: (span.quarter - 1) * 3 + offset,
      }));
    case "month": {
      const days = new Date(Date.UTC(span.year, span.month, 0)).getUTCDate();
      return Array.from({ length: days }, (_, index) => ({
        unit: "day",
        start: new Date(Date.UTC(span.year, span.month - 1, index + 1)),
      }));
    }
    case "day":
      return hourRanges(span.start, 24, HALF_DAY_HOURS);
    case "hours":
      return span.hours === 1 ? [] : hourRanges(span.start, span.hours, 1);
  }
}

function hourRanges(from: Date, total: number, hours: number): Span[] {
  return Array.from({ length: total / hours }, (_, index) => ({
    unit: "hours",
    start: new Date(from.getTime() + index * hours * HOUR_MS),
    hours,
  }));
}

// The collection rejects a window reaching into the future, so one still in
// progress stops at now. Bounds are inclusive, so a window ends a second before
// the next one starts.
function window(span: Span, now: Date): ContributionsWindow {
  const end = new Date(after(span).getTime() - 1000);
  return { key: key(span), from: start(span), to: now < end ? now : end };
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

  match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match !== null) {
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? { unit: "month", year: Number(match[1]), month } : null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return roundTrips({ unit: "day", start: new Date(`${value}T00:00:00Z`) }, value);
  }

  match = /^(\d{4}-\d{2}-\d{2}T\d{2})--(\d{4}-\d{2}-\d{2}T\d{2})$/.exec(value);
  if (match !== null) {
    const from = new Date(`${match[1]}:00:00Z`);
    const hours = (Date.parse(`${match[2]}:00:00Z`) - from.getTime()) / HOUR_MS;
    const aligned = from.getUTCHours() % hours === 0;
    return (hours === HALF_DAY_HOURS || hours === 1) && aligned
      ? roundTrips({ unit: "hours", start: from, hours }, value)
      : null;
  }

  return null;
}

// `Date` rolls an impossible day like 2015-02-30 into March rather than failing,
// so a key only parses when it names the window it produces.
function roundTrips(span: Span, value: string): Span | null {
  return !Number.isNaN(start(span).getTime()) && key(span) === value ? span : null;
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

// The narrower windows a truncated one is fetched again as, leaving out any yet
// to start. An hour has none.
export function splitContributions(value: string, now: Date): ContributionsWindow[] {
  return children(spanOf(value)).flatMap((child) => (start(child) > now ? [] : window(child, now)));
}

// A window narrower than a day counts only part of each day's commits, so its
// rows add up with its siblings' rather than standing alone. Null for a day or
// anything wider.
export function enclosingDay(value: string): string | null {
  const span = parse(value);
  return span?.unit === "hours" ? dayKey(span.start) : null;
}

// The cross-check compares a whole year's totals, so only a year window has
// one to compare.
export function windowYear(value: string): number | null {
  const span = parse(value);
  return span?.unit === "year" ? span.year : null;
}
