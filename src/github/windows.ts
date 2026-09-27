// The search connection returns at most 1,000 results per query. A backfill
// window is a month, and one whose `issueCount` passes the cap narrows: a month
// to halves of its days, a range of days to halves again down to a single day,
// a day to halves, and a half to hours. Each window's key names its prefix in
// R2 and its row in the crawl frontier.
import { Temporal } from "temporal-polyfill";
import {
  dayHalves,
  fromUtc,
  type HourRange,
  hourRangeEnd,
  hourRangeKey,
  parseDay,
  parseHourRange,
  parseYearMonth,
  splitHourRange,
  startsAfter,
} from "./spans";

export type EventKind = "pr-authored" | "pr-reviewed" | "issue";

export interface Month {
  year: number;
  // 1-12, matching how a month reads rather than how `Date` numbers it.
  month: number;
}

export interface CreatedWindow {
  // `2026-08`, `2026-08-01--2026-08-15`, `2026-08-14`, or an hour range such as
  // `2026-08-14T00--2026-08-14T12`.
  key: string;
  // The bounds of the `created:` qualifier, both inclusive: dates for a window
  // of whole days, instants for one narrower.
  start: string;
  end: string;
  // The window's last instant, which a backfill leaves the watermark at.
  through: string;
}

export class InvalidSearchWindowError extends Error {
  constructor(value: string) {
    super(`${value} is not a search window`);
    this.name = "InvalidSearchWindowError";
  }
}

type Span =
  | { unit: "month"; month: Temporal.PlainYearMonth }
  | { unit: "days"; start: Temporal.PlainDate; days: number }
  | HourRange;

// Search reads second-precision timestamps, so an instant bound stops at the
// second.
function instant(time: Temporal.PlainDateTime): string {
  return `${time.toString({ smallestUnit: "second" })}Z`;
}

function firstDay(span: Exclude<Span, HourRange>): Temporal.PlainDate {
  return span.unit === "month" ? span.month.toPlainDate({ day: 1 }) : span.start;
}

function start(span: Span): Temporal.PlainDateTime {
  return span.unit === "hours" ? span.start : firstDay(span).toPlainDateTime();
}

// The first instant after the window.
function after(span: Span): Temporal.PlainDateTime {
  switch (span.unit) {
    case "month":
      return start(span).add({ months: 1 });
    case "days":
      return start(span).add({ days: span.days });
    case "hours":
      return hourRangeEnd(span);
  }
}

// Day ranges name their last day, the way a `created:` range reads. Hour ranges
// name the hour they stop before, the way the contributions windows do.
function key(span: Span): string {
  switch (span.unit) {
    case "month":
      return span.month.toString();
    case "days": {
      const first = span.start.toString();
      const last = span.start.add({ days: span.days - 1 }).toString();
      return span.days === 1 ? first : `${first}--${last}`;
    }
    case "hours":
      return hourRangeKey(span);
  }
}

function toWindow(span: Span): CreatedWindow {
  const through = after(span).subtract({ milliseconds: 1 });
  const [from, to] =
    span.unit === "hours"
      ? [instant(span.start), instant(through)]
      : [firstDay(span).toString(), through.toPlainDate().toString()];
  return {
    key: key(span),
    start: from,
    end: to,
    through: `${through.toString({ smallestUnit: "millisecond" })}Z`,
  };
}

// Halving costs fewer requests than a window per day: a month over the cap
// usually needs only its two halves.
function halves(from: Temporal.PlainDate, days: number): Span[] {
  const first = Math.floor(days / 2);
  return [
    { unit: "days", start: from, days: first },
    { unit: "days", start: from.add({ days: first }), days: days - first },
  ];
}

function children(span: Span): Span[] {
  switch (span.unit) {
    case "month":
      return halves(firstDay(span), span.month.daysInMonth);
    case "days":
      return span.days === 1 ? dayHalves(span.start) : halves(span.start, span.days);
    case "hours":
      return splitHourRange(span);
  }
}

function parse(value: string): Span | null {
  const month = parseYearMonth(value);
  if (month !== null) {
    return { unit: "month", month };
  }

  const match = /^(\d{4}-\d{2}-\d{2})(?:--(\d{4}-\d{2}-\d{2}))?$/.exec(value);
  if (match !== null) {
    const from = parseDay(match[1] ?? "");
    const last = match[2] === undefined ? from : parseDay(match[2]);
    if (from === null || last === null) {
      return null;
    }
    // A single day is written as the day, so a range has to run forward past
    // its first day to be a key some window produces.
    const days = from.until(last).days + 1;
    return match[2] === undefined || days > 1 ? { unit: "days", start: from, days } : null;
  }

  return parseHourRange(value);
}

function spanOf(value: string): Span {
  const span = parse(value);
  if (span === null) {
    throw new InvalidSearchWindowError(value);
  }
  return span;
}

export function createdWindow(value: string): CreatedWindow {
  return toWindow(spanOf(value));
}

export function monthWindow(month: Month): CreatedWindow {
  return toWindow({ unit: "month", month: Temporal.PlainYearMonth.from(month) });
}

export function monthlyWindows(from: Month, now: Date): CreatedWindow[] {
  const windows: CreatedWindow[] = [];
  const last = fromUtc(now).toPlainDate().toPlainYearMonth();

  for (
    let month = Temporal.PlainYearMonth.from(from);
    Temporal.PlainYearMonth.compare(month, last) <= 0;
    month = month.add({ months: 1 })
  ) {
    windows.push(toWindow({ unit: "month", month }));
  }

  return windows;
}

// The narrower windows a truncated one is fetched again as, leaving out any yet
// to start. An hour has none.
export function splitCreatedWindow(value: string, now: Date): string[] {
  return children(spanOf(value)).flatMap((child) =>
    startsAfter(start(child), now) ? [] : key(child),
  );
}

const SCOPES: Record<EventKind, (login: string) => string> = {
  "pr-authored": (login) => `is:pr author:${login}`,
  // Replying to a review thread on your own pull request submits a review, so
  // without the exclusion every such reply reads as a review given.
  "pr-reviewed": (login) => `is:pr reviewed-by:${login} -author:${login}`,
  issue: (login) => `is:issue author:${login}`,
};

function scope(kind: EventKind, login: string): string {
  return SCOPES[kind](login);
}

export function backfillSearch(kind: EventKind, login: string, window: CreatedWindow): string {
  return `${scope(kind, login)} created:${window.start}..${window.end}`;
}

// What an incremental search reads: everything updated from `since` through
// `until`, both ISO instants. The upper bound is what lets a window too large
// for one query split.
export interface UpdatedRange {
  since: string;
  until: string;
}

// GitHub's search index lags writes, so `since` is set behind the last sync and
// the overlap is free against upserts keyed on node ID.
export function incrementalSearch(kind: EventKind, login: string, range: UpdatedRange): string {
  return `${scope(kind, login)} updated:${range.since}..${range.until}`;
}

// A range matching more than the cap after an outage halves at its midpoint,
// on a whole second since search reads no finer. The halves share that second,
// which upserts absorb. A range a second wide has nowhere to split.
export function splitUpdated(range: UpdatedRange): UpdatedRange[] {
  const since = Date.parse(range.since);
  const until = Date.parse(range.until);
  const middle = new Date(Math.floor((since + until) / 2000) * 1000).toISOString();
  return middle <= range.since || middle >= range.until
    ? []
    : [
        { since: range.since, until: middle },
        { since: middle, until: range.until },
      ];
}
