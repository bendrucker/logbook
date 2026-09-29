import { Temporal } from "temporal-polyfill";

// The calendar arithmetic the contributions and search windows share. Both
// read every date and time as UTC, narrow a day to halves and a half to hours,
// and name an hour range by the hour it starts on and the hour it stops before.
// An hour is the finest window, so one still truncated there is irreducible.

export interface HourRange {
  unit: "hours";
  start: Temporal.PlainDateTime;
  hours: number;
}

const HALF_DAY_HOURS = 12;

// Temporal refuses an impossible date like 2015-02-30 where `Date` would roll it
// into March, so a key naming one parses to null.
function strictly<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

export function parseYearMonth(value: string): Temporal.PlainYearMonth | null {
  return /^\d{4}-\d{2}$/.test(value) ? strictly(() => Temporal.PlainYearMonth.from(value)) : null;
}

export function parseDay(value: string): Temporal.PlainDate | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? strictly(() => Temporal.PlainDate.from(value)) : null;
}

function parseHour(value: string | undefined): Temporal.PlainDateTime | null {
  return value === undefined ? null : strictly(() => Temporal.PlainDateTime.from(value));
}

// A half day or a single hour, starting on a multiple of its own length.
export function parseHourRange(value: string): HourRange | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})--(\d{4}-\d{2}-\d{2}T\d{2})$/.exec(value);
  const start = parseHour(match?.[1]);
  const stop = parseHour(match?.[2]);
  if (start === null || stop === null) {
    return null;
  }
  const { hours } = start.until(stop, { largestUnit: "hour" });
  const aligned = start.hour % hours === 0;
  return (hours === HALF_DAY_HOURS || hours === 1) && aligned
    ? { unit: "hours", start, hours }
    : null;
}

function hourKey(time: Temporal.PlainDateTime): string {
  return `${time.toPlainDate().toString()}T${String(time.hour).padStart(2, "0")}`;
}

export function hourRangeEnd(range: HourRange): Temporal.PlainDateTime {
  return range.start.add({ hours: range.hours });
}

export function hourRangeKey(range: HourRange): string {
  return `${hourKey(range.start)}--${hourKey(hourRangeEnd(range))}`;
}

function hourRanges(from: Temporal.PlainDateTime, total: number, hours: number): HourRange[] {
  return Array.from({ length: total / hours }, (_, index) => ({
    unit: "hours",
    start: from.add({ hours: index * hours }),
    hours,
  }));
}

export function dayHalves(day: Temporal.PlainDate): HourRange[] {
  return hourRanges(day.toPlainDateTime(), 24, HALF_DAY_HOURS);
}

// An hour has nothing narrower.
export function splitHourRange(range: HourRange): HourRange[] {
  return range.hours === 1 ? [] : hourRanges(range.start, range.hours, 1);
}

export function fromUtc(date: Date): Temporal.PlainDateTime {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO("UTC")
    .toPlainDateTime();
}

export function toUtc(time: Temporal.PlainDateTime): Date {
  return new Date(time.toZonedDateTime("UTC").epochMilliseconds);
}

export function startsAfter(time: Temporal.PlainDateTime, now: Date): boolean {
  return Temporal.PlainDateTime.compare(time, fromUtc(now)) > 0;
}
