import type { TraktKind } from "../sync/kinds";
import { MissingSecretError, type SyncResult } from "../sync/run";
import { readWatermark } from "../sync/state";
import { drainTraktHistory } from "./backfill";
import { RequestCap, type TraktOptions } from "./client";
import {
  syncHistoryWindow,
  syncRatings,
  traktClientId,
  type TraktSyncOptions,
  watchedWindow,
  yearWindow,
} from "./sync";

// A play logged late, by hand or by a scrobble that posted after the fact,
// carries a `watched_at` behind the watermark, so the window opens a day back.
const OVERLAP_MS = 24 * 60 * 60 * 1000;

export interface TraktInvocationOptions extends Omit<TraktOptions, "requests"> {
  now?: Date;
}

// History off its watermark, then the full ratings list, then whatever the cap
// leaves for windows a backfill enqueued.
export async function syncTrakt(env: Env, options: TraktInvocationOptions = {}): Promise<void> {
  if (!configured(env)) {
    return;
  }
  const now = options.now ?? new Date();
  const requests = new RequestCap(env.RATE_CAP_TRAKT);
  const sync = { ...options, now, requests };

  // A cap or a 429 belongs to the application rather than to one kind, so the
  // first stop ends the invocation.
  const history = await contained("trakt-history", syncHistory(env, sync));
  if (history?.resumeAt != null) {
    return;
  }
  const ratings = await contained("trakt-ratings", syncRatings(env, sync));
  if (ratings?.resumeAt != null) {
    return;
  }

  // The drain takes the caller's options rather than the fixed `now` above, so
  // each of its runs stamps its own time.
  try {
    await drainTraktHistory(env, { ...options, requests });
  } catch (error) {
    console.error(`trakt-history backfill drain failed: ${String(error)}`);
  }
}

// A play logged with a past date falls behind every hourly window, since those
// filter on `watched_at`. The nightly pass re-reads the current year to catch
// the ones backdated within it. It leaves the watermark alone, so it never
// declares an unbackfilled history synced.
export async function rewalkTraktYear(
  env: Env,
  options: TraktInvocationOptions = {},
): Promise<SyncResult | null> {
  if (!configured(env)) {
    return null;
  }
  const now = options.now ?? new Date();
  return syncHistoryWindow(env, yearWindow(now.getUTCFullYear(), now, false), {
    ...options,
    now,
    requests: new RequestCap(env.RATE_CAP_TRAKT),
  });
}

async function syncHistory(
  env: Env,
  options: TraktSyncOptions & { now: Date },
): Promise<SyncResult | null> {
  const watermark = await readWatermark(env.DB, "trakt-history");
  if (watermark === null) {
    // Anchoring at now would declare every earlier play synced.
    console.log("trakt-history has no watermark, so a backfill owns its first window");
    return null;
  }
  const since = new Date(Date.parse(watermark.window) - OVERLAP_MS).toISOString();
  return syncHistoryWindow(env, watchedWindow(since, options.now.toISOString()), options);
}

// A cron that throws retries on the next hour and reports nothing useful in
// between, and no amount of retrying sets a secret.
function configured(env: Env): boolean {
  try {
    traktClientId(env);
    return true;
  } catch (error) {
    if (!(error instanceof MissingSecretError)) {
      throw error;
    }
    console.error(error.message);
    return false;
  }
}

// One kind's storage failure is not the other kind's problem.
async function contained(
  kind: TraktKind,
  run: Promise<SyncResult | null>,
): Promise<SyncResult | null> {
  try {
    return await run;
  } catch (error) {
    console.error(`${kind} sync failed: ${String(error)}`);
    return null;
  }
}
