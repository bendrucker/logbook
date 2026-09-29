import {
  type EventKind,
  incrementalSearch,
  splitUpdated,
  type UpdatedRange,
} from "../github/windows";
import { drainBackfill } from "./backfill";
import { BACKFILL_SPACING_MS, type Budget, openBudget, syncLimits } from "./budget";
import { SEARCH_KINDS, type SyncKind } from "./kinds";
import {
  githubToken,
  type InvocationOptions,
  MissingSecretError,
  syncContributions,
  type SyncResult,
  syncWindow,
} from "./run";
import { readWatermark } from "./state";

// GitHub's search index lags writes by an unspecified interval, so the window
// opens behind the watermark instead of at it. An hour covers the lag, and the
// overlap costs nothing against upserts keyed on node ID.
const OVERLAP_MS = 60 * 60 * 1000;

export async function syncIncremental(env: Env, options: InvocationOptions = {}): Promise<void> {
  const now = options.now ?? new Date();

  try {
    githubToken(env);
  } catch (error) {
    if (!(error instanceof MissingSecretError)) {
      throw error;
    }
    // A cron that throws retries on the next hour and reports nothing useful in
    // between, and no amount of retrying sets a secret.
    console.error(error.message);
    return;
  }

  const budget = await openBudget(env.DB, syncLimits(env), { now, clock: options.clock });
  const sync = { ...options, now, budget };

  // The kinds run one after another so the budget limit the first one reaches
  // stops the invocation, rather than three concurrent runs each spending their
  // way to the same discovery.
  for (const kind of SEARCH_KINDS) {
    // oxlint-disable-next-line no-await-in-loop -- the first kind the budget refuses ends the invocation
    const result = await contained(kind, syncKind(env, kind, sync));
    if (result !== null && result.resumeAt !== null) {
      return;
    }
  }

  const contributions = await contained(
    "contributions",
    syncContributions(env, now.getUTCFullYear(), sync),
  );
  if (contributions !== null && contributions.resumeAt !== null) {
    return;
  }

  // Leftover share goes to the windows a backfill enqueued, at the floor and
  // spacing a backfill keeps. The drain takes the caller's options rather than
  // the fixed `now` above, so each of its runs stamps its own time and a unit
  // for the current year never lands on the key the run above just wrote.
  try {
    await drainBackfill(env, {
      ...options,
      budget: budget.withLimits({
        floor: env.RATE_FLOOR_BACKFILL,
        spacingMs: BACKFILL_SPACING_MS,
      }),
    });
  } catch (error) {
    console.error(`backfill drain failed: ${String(error)}`);
  }
}

// One kind's storage failure is not the other kinds' problem, and a throw here
// would end the invocation before they ran.
async function contained(
  kind: SyncKind,
  run: Promise<SyncResult | null>,
): Promise<SyncResult | null> {
  try {
    return await run;
  } catch (error) {
    console.error(`${kind} sync failed: ${String(error)}`);
    return null;
  }
}

async function syncKind(
  env: Env,
  kind: EventKind,
  options: InvocationOptions & { now: Date; budget: Budget },
): Promise<SyncResult | null> {
  const { now } = options;
  const watermark = await readWatermark(env.DB, kind);
  if (watermark === null) {
    // Anchoring at now would declare every event before this invocation synced
    // and leave the history unreachable except by replay.
    console.log(`${kind} has no watermark, so a backfill owns its first window`);
    return null;
  }

  const since = new Date(Date.parse(watermark.window) - OVERLAP_MS).toISOString();

  // A range matching more than the cap, which a long outage can leave behind,
  // is fetched again as its halves, earliest first, so the watermark climbs
  // through each half as it lands. The first half that fails stops the kind:
  // a later one landing would move the watermark past what it missed.
  const pending: UpdatedRange[] = [{ since, until: now.toISOString() }];
  let result: SyncResult | null = null;
  let range = pending.shift();
  while (range !== undefined) {
    const halves = splitUpdated(range);
    // oxlint-disable-next-line no-await-in-loop -- a half lands before the next so the watermark climbs through it
    result = await syncWindow(
      env,
      kind,
      {
        key: `updated:${range.since}..${range.until}`,
        query: incrementalSearch(kind, env.GITHUB_LOGIN, range),
        through: range.until,
        splits: halves.length > 0,
      },
      options,
    );
    if (result.error !== null) {
      return result;
    }
    if (result.truncated) {
      pending.unshift(...halves);
    }
    range = pending.shift();
  }

  return result;
}
