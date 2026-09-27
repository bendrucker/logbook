// The search connection returns at most 1,000 results per query and reports
// nothing when a query matched more. Monthly windows keep every query far
// under that, and these boundaries are what the whole cap mitigation rests on.
export type EventKind = "pr-authored" | "pr-reviewed" | "issue";

export interface Month {
  year: number;
  // 1-12, matching how a month reads rather than how `Date` numbers it.
  month: number;
}

export interface MonthWindow {
  key: string;
  start: string;
  end: string;
}

// Day zero of the following month is the last day of this one. A literal `-31`
// against a thirty-day month is a date GitHub's parser has to reinterpret.
function lastDay({ year, month }: Month): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function monthWindow(month: Month): MonthWindow {
  const key = `${month.year}-${pad(month.month)}`;
  return { key, start: `${key}-01`, end: `${key}-${pad(lastDay(month))}` };
}

export function monthlyWindows(start: Month, now: Date): MonthWindow[] {
  const windows: MonthWindow[] = [];
  const first = start.year * 12 + (start.month - 1);
  const last = now.getUTCFullYear() * 12 + now.getUTCMonth();

  for (let index = first; index <= last; index++) {
    windows.push(monthWindow({ year: Math.floor(index / 12), month: (index % 12) + 1 }));
  }

  return windows;
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

export function backfillSearch(kind: EventKind, login: string, window: MonthWindow): string {
  return `${scope(kind, login)} created:${window.start}..${window.end}`;
}

// GitHub's search index lags writes, so `since` is set behind the last sync and
// the overlap is free against upserts keyed on node ID.
export function incrementalSearch(kind: EventKind, login: string, since: string): string {
  return `${scope(kind, login)} updated:>${since}`;
}
