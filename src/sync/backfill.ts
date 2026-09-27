import { backfillSearch, type Month, monthlyWindows } from "../github/windows";
import { backfillLimits, openBudget } from "./budget";
import type { SyncKind } from "./kinds";
import {
  githubToken,
  type InvocationOptions,
  syncContributions,
  syncedThrough,
  type SyncOptions,
  type SyncResult,
  syncWindow,
} from "./run";

// I created my first repository on 2012-12-27, so nothing earlier matches.
export const BACKFILL_START: Month = { year: 2012, month: 12 };

export class InvalidMonthError extends Error {
  constructor(value: string) {
    super(`${value} is not a YYYY-MM month`);
    this.name = "InvalidMonthError";
  }
}

export interface BackfillResult {
  kind: SyncKind;
  windows: string[];
  pages: number;
  rowsChanged: number;
  // Where the next call resumes, or null once the walk reaches the present.
  next: string | null;
  // Set when the rate budget or a secondary limit stopped the call: the next
  // call resumes at `next` once this instant passes.
  resumeAt: string | null;
  error: string | null;
}

export function parseMonth(value: string): Month {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new InvalidMonthError(value);
  }
  const [year, month] = [Number(match[1]), Number(match[2])];
  if (month < 1 || month > 12) {
    throw new InvalidMonthError(value);
  }
  return { year, month };
}

export async function backfill(
  env: Env,
  kind: SyncKind,
  from: Month,
  options: InvocationOptions = {},
): Promise<BackfillResult> {
  // Read before the walk starts so an unconfigured deployment answers the
  // caller instead of writing a run row per month saying the same thing.
  githubToken(env);

  const budget = await openBudget(env.DB, backfillLimits(env), options);
  const sync = { ...options, budget };
  return kind === "contributions"
    ? backfillContributions(env, from.year, sync)
    : backfillSearchWindows(env, kind, from, sync);
}

async function backfillSearchWindows(
  env: Env,
  kind: Exclude<SyncKind, "contributions">,
  from: Month,
  options: SyncOptions,
): Promise<BackfillResult> {
  const now = options.now ?? new Date();
  const pending = monthlyWindows(from, now);
  const walking = pending.slice(0, env.BACKFILL_WINDOWS);
  const result: BackfillResult = {
    kind,
    windows: [],
    pages: 0,
    rowsChanged: 0,
    next: pending[env.BACKFILL_WINDOWS]?.key ?? null,
    resumeAt: null,
    error: null,
  };

  const remaining = [...walking];
  let window = remaining.shift();
  while (window !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const run = await syncWindow(
      env,
      kind,
      {
        key: window.key,
        query: backfillSearch(kind, env.GITHUB_LOGIN, window),
        // A `created:` window says nothing about events updated after it
        // closed. It leaves the watermark at the month's end and the
        // incremental sync picks up whatever moved since.
        through: syncedThrough(`${window.end}T23:59:59.999Z`, now),
      },
      options,
    );
    record(result, window.key, run);
    if (run.error !== null) {
      return { ...result, next: window.key };
    }
    window = remaining.shift();
  }

  return result;
}

async function backfillContributions(
  env: Env,
  from: number,
  options: SyncOptions,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    kind: "contributions",
    windows: [],
    pages: 0,
    rowsChanged: 0,
    next: null,
    resumeAt: null,
    error: null,
  };

  // The first year is what reports `contributionYears`, so the walk learns
  // which years exist from the same request that syncs one of them.
  const first = await syncContributions(env, from, options);
  record(result, String(from), first);
  if (first.error !== null) {
    return { ...result, next: resume(from) };
  }

  const years = first.contributionYears.filter((year) => year > from).toSorted((a, b) => a - b);
  const remaining = years.slice(0, env.BACKFILL_WINDOWS - 1);
  let year = remaining.shift();
  while (year !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const run = await syncContributions(env, year, options);
    record(result, String(year), run);
    if (run.error !== null) {
      return { ...result, next: resume(year) };
    }
    year = remaining.shift();
  }

  return { ...result, next: resume(years[env.BACKFILL_WINDOWS - 1]) };
}

// `next` goes back in as `from`, so a year resumes in the month format the
// route parses even though the collection is windowed by year.
function resume(year: number | undefined): string | null {
  return year === undefined ? null : `${year}-01`;
}

function record(result: BackfillResult, window: string, run: SyncResult): void {
  result.windows.push(window);
  result.pages += run.pages;
  result.rowsChanged += run.rowsChanged;
  result.resumeAt = run.resumeAt;
  result.error = run.error;
}
