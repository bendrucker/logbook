// The search connection returns at most 1,000 results per query. A backfill
// window is a month, and one whose `issueCount` passes the cap narrows: a month
// to halves of its days, a range of days to halves again down to a single day,
// a day to halves, and a half to hours. Each window's key names its prefix in
// R2 and its row in the crawl frontier.
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A day splits into halves and a half into hours. An hour is the finest window,
// so one still truncated there is irreducible.
const HALF_DAY_HOURS = 12;

type Span =
  | { unit: "month"; year: number; month: number }
  | { unit: "days"; start: Date; days: number }
  | { unit: "hours"; start: Date; hours: number };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, "2026-08-14".length);
}

function hourKey(date: Date): string {
  return date.toISOString().slice(0, "2026-08-14T00".length);
}

// Search reads second-precision timestamps, so an instant bound drops the
// milliseconds `toISOString` adds.
function instant(date: Date): string {
  return `${date.toISOString().slice(0, "2026-08-14T00:00:00".length)}Z`;
}

// Day zero of the following month is the last day of this one. A literal `-31`
// against a thirty-day month is a date GitHub's parser has to reinterpret.
function daysIn({ year, month }: Month): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function start(span: Span): Date {
  return span.unit === "month" ? new Date(Date.UTC(span.year, span.month - 1, 1)) : span.start;
}

// The first instant after the window.
function after(span: Span): Date {
  switch (span.unit) {
    case "month":
      return new Date(Date.UTC(span.year, span.month, 1));
    case "days":
      return new Date(span.start.getTime() + span.days * DAY_MS);
    case "hours":
      return new Date(span.start.getTime() + span.hours * HOUR_MS);
  }
}

// Day ranges name their last day, the way a `created:` range reads. Hour ranges
// name the hour they stop before, the way the contributions windows do.
function key(span: Span): string {
  switch (span.unit) {
    case "month":
      return `${span.year}-${pad(span.month)}`;
    case "days": {
      const first = dayKey(span.start);
      const last = dayKey(new Date(after(span).getTime() - DAY_MS));
      return span.days === 1 ? first : `${first}--${last}`;
    }
    case "hours":
      return `${hourKey(span.start)}--${hourKey(after(span))}`;
  }
}

function toWindow(span: Span): CreatedWindow {
  const through = new Date(after(span).getTime() - 1);
  const [from, to] =
    span.unit === "hours"
      ? [instant(span.start), instant(through)]
      : [dayKey(start(span)), dayKey(through)];
  return { key: key(span), start: from, end: to, through: through.toISOString() };
}

// Halving costs fewer requests than a window per day: a month over the cap
// usually needs only its two halves.
function halves(from: Date, days: number): Span[] {
  const first = Math.floor(days / 2);
  return [
    { unit: "days", start: from, days: first },
    { unit: "days", start: new Date(from.getTime() + first * DAY_MS), days: days - first },
  ];
}

function hourRanges(from: Date, total: number, hours: number): Span[] {
  return Array.from({ length: total / hours }, (_, index) => ({
    unit: "hours",
    start: new Date(from.getTime() + index * hours * HOUR_MS),
    hours,
  }));
}

function children(span: Span): Span[] {
  switch (span.unit) {
    case "month":
      return halves(start(span), daysIn(span));
    case "days":
      return span.days === 1
        ? hourRanges(span.start, 24, HALF_DAY_HOURS)
        : halves(span.start, span.days);
    case "hours":
      return span.hours === 1 ? [] : hourRanges(span.start, span.hours, 1);
  }
}

function parse(value: string): Span | null {
  let match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match !== null) {
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? { unit: "month", year: Number(match[1]), month } : null;
  }

  match = /^(\d{4}-\d{2}-\d{2})(?:--(\d{4}-\d{2}-\d{2}))?$/.exec(value);
  if (match !== null) {
    const from = new Date(`${match[1]}T00:00:00Z`);
    const last = match[2] === undefined ? from : new Date(`${match[2]}T00:00:00Z`);
    const days = Math.round((last.getTime() - from.getTime()) / DAY_MS) + 1;
    return days >= 1 ? roundTrips({ unit: "days", start: from, days }, value) : null;
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
// and a one-day range reads the same as the day, so a key only parses when it
// is the name its window produces.
function roundTrips(span: Span, value: string): Span | null {
  return !Number.isNaN(start(span).getTime()) && key(span) === value ? span : null;
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
  return toWindow({ unit: "month", ...month });
}

export function monthlyWindows(from: Month, now: Date): CreatedWindow[] {
  const windows: CreatedWindow[] = [];
  const first = from.year * 12 + (from.month - 1);
  const last = now.getUTCFullYear() * 12 + now.getUTCMonth();

  for (let index = first; index <= last; index++) {
    windows.push(monthWindow({ year: Math.floor(index / 12), month: (index % 12) + 1 }));
  }

  return windows;
}

// The narrower windows a truncated one is fetched again as, leaving out any yet
// to start. An hour has none.
export function splitCreatedWindow(value: string, now: Date): string[] {
  return children(spanOf(value)).flatMap((child) => (start(child) > now ? [] : key(child)));
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
