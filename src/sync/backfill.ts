import { splitContributions } from "../github/calendar";
import {
  backfillSearch,
  createdWindow,
  type EventKind,
  type Month,
  monthlyWindows,
  splitCreatedWindow,
} from "../github/windows";
import { backfillLimits, openBudget } from "./budget";
import { type CrawlSource, drain, enqueue, frontierStatus, type UnitFetch } from "./frontier";
import { syncContributionEventsWindow } from "./contribution-events";
import { isContributionEventsKind, SYNC_KINDS, type SyncKind } from "./kinds";
import {
  githubToken,
  type InvocationOptions,
  syncContributionsWindow,
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
  // The units this call fetched, in the order it fetched them.
  windows: string[];
  pages: number;
  rowsChanged: number;
  // Units still waiting, which the next call or the hourly cron drains.
  pending: number;
  // Windows still truncated at the finest split, which no further crawl
  // recovers.
  irreducible: string[];
  // Set when the rate budget or a secondary limit stopped the call: the next
  // call carries on once this instant passes.
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

// Roots already in the frontier keep their status, so calling again with the
// same `from` carries on where the last call stopped.
export async function backfill(
  env: Env,
  kind: SyncKind,
  from: Month,
  options: InvocationOptions = {},
): Promise<BackfillResult> {
  // Read before the walk starts so an unconfigured deployment answers the
  // caller instead of writing a run row per window saying the same thing.
  githubToken(env);

  const now = options.now ?? new Date();
  await enqueue(env.DB, kind, roots(kind, from, now), now.toISOString());

  const budget = await openBudget(env.DB, backfillLimits(env), options);
  const drained = await drain(env.DB, kind, crawlSource(env, kind, { ...options, budget }));
  const status = (await frontierStatus(env.DB)).get(kind);

  return {
    kind,
    ...drained,
    pending: status?.pending ?? 0,
    irreducible: status?.irreducible ?? [],
  };
}

// The hourly cron spends what its incremental work left of the budget on
// windows a backfill enqueued, so a large backfill finishes across hours
// without anyone rerunning the script. It stops at the first kind a limit
// refuses, since the limit belongs to the token.
export async function drainBackfill(env: Env, options: SyncOptions): Promise<void> {
  const remaining = [...SYNC_KINDS];
  let kind = remaining.shift();
  while (kind !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const drained = await drain(env.DB, kind, crawlSource(env, kind, options));
    if (drained.error !== null) {
      console.error(`${kind} backfill drain stopped: ${drained.error}`);
    }
    if (drained.resumeAt !== null) {
      return;
    }
    kind = remaining.shift();
  }
}

function roots(kind: SyncKind, from: Month, now: Date): string[] {
  if (kind === "contributions" || isContributionEventsKind(kind)) {
    const last = now.getUTCFullYear();
    return last < from.year
      ? []
      : Array.from({ length: last - from.year + 1 }, (_, index) => String(from.year + index));
  }
  return monthlyWindows(from, now).map((window) => window.key);
}

function crawlSource(env: Env, kind: SyncKind, options: SyncOptions): CrawlSource {
  const now = options.now ?? new Date();
  const split = (window: string) => splitContributions(window, now).map((child) => child.key);
  if (kind === "contributions") {
    return {
      fetch: async (window) => unitFetch(await syncContributionsWindow(env, window, options)),
      split,
    };
  }
  if (isContributionEventsKind(kind)) {
    return {
      fetch: async (window) =>
        unitFetch(await syncContributionEventsWindow(env, kind, window, options)),
      split,
    };
  }
  return {
    fetch: async (window) => unitFetch(await searchCreated(env, kind, window, options)),
    split: (window) => splitCreatedWindow(window, now),
  };
}

function searchCreated(
  env: Env,
  kind: EventKind,
  key: string,
  options: SyncOptions,
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const window = createdWindow(key);
  return syncWindow(
    env,
    kind,
    {
      key: window.key,
      query: backfillSearch(kind, env.GITHUB_LOGIN, window),
      // A `created:` window says nothing about events updated after it
      // closed. It leaves the watermark at the window's end and the
      // incremental sync picks up whatever moved since.
      through: syncedThrough(window.through, now),
      splits: splitCreatedWindow(key, now).length > 0,
    },
    options,
  );
}

function unitFetch(run: SyncResult): UnitFetch {
  return {
    fetchedAt: run.fetchedAt,
    pages: run.pages,
    rowsChanged: run.rowsChanged,
    cost: run.cost,
    truncated: run.truncated,
    error: run.error,
    resumeAt: run.resumeAt,
  };
}
