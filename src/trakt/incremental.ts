import { frontierStatus } from "../sync/frontier";
import type { TraktKind } from "../sync/kinds";
import { MissingSecretError, type SyncResult } from "../sync/run";
import { recordSkip } from "../sync/runs";
import { readWatermark } from "../sync/state";
import { drainTraktHistory } from "./backfill";
import { RequestCap } from "../request-cap";
import { type TraktAuth, traktAuth } from "./auth";
import type { TraktOptions } from "./client";
import {
  syncHistoryWindow,
  syncRatings,
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

export async function syncTrakt(env: Env, options: TraktInvocationOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const auth = await linked(env, options, now);
  if (auth === null) {
    await recordSkip(env.DB, "trakt-history", "skip.missing_secret", now.toISOString());
    await recordSkip(env.DB, "trakt-ratings", "skip.missing_secret", now.toISOString());
    return;
  }
  const requests = new RequestCap(env.RATE_CAP_TRAKT);
  const sync = { ...options, auth, now, requests };

  // A cap or a 429 belongs to the application rather than to one kind, so the
  // first stop ends the invocation.
  const history = await contained("trakt-history", syncHistory(env, sync));
  if (history?.resumeAt != null) {
    await recordSkip(env.DB, "trakt-ratings", "skip.rate_limited", now.toISOString());
    return;
  }
  const ratings = await contained("trakt-ratings", syncRatings(env, sync));
  if (ratings?.resumeAt != null) {
    return;
  }

  // The drain takes the caller's options rather than the fixed `now` above, so
  // each of its runs stamps its own time.
  try {
    await drainTraktHistory(env, { ...options, auth, requests });
  } catch (error) {
    console.error({ event: "backfill.drain_failed", kind: "trakt-history", error: String(error) });
  }
}

// A play logged with a past date falls behind every hourly window, since those
// filter on `watched_at`. The nightly pass re-reads the current year to catch
// the ones backdated within it. It leaves the watermark alone, so it never
// declares an unbackfilled history synced.
export async function rewalkTraktYear(
  env: Env,
  options: TraktInvocationOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  return syncHistoryWindow(env, yearWindow(now.getUTCFullYear(), now, false), {
    ...options,
    auth: options.auth ?? (await traktAuth(env, { ...options, now })),
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
    console.log({ event: "sync.skipped", kind: "trakt-history", reason: "skip.no_watermark" });
    await recordSkip(env.DB, "trakt-history", "skip.no_watermark", options.now.toISOString());
    return null;
  }
  // A backfill that stopped partway leaves the watermark at the end of the last
  // year it finished, and a window from there to now can outgrow the cap every
  // hour. The drain reads those years one at a time instead.
  if (((await frontierStatus(env.DB)).get("trakt-history")?.pending ?? 0) > 0) {
    console.log({ event: "sync.skipped", kind: "trakt-history", reason: "skip.backfill_pending" });
    await recordSkip(env.DB, "trakt-history", "skip.backfill_pending", options.now.toISOString());
    return null;
  }
  const since = new Date(Date.parse(watermark.window) - OVERLAP_MS).toISOString();
  return syncHistoryWindow(env, watchedWindow(since, options.now.toISOString()), options);
}

// Null when no device login has stored a grant, which no retry fixes.
async function linked(
  env: Env,
  options: TraktInvocationOptions,
  now: Date,
): Promise<TraktAuth | null> {
  if (options.auth !== undefined) {
    return options.auth;
  }
  try {
    return await traktAuth(env, { ...options, now });
  } catch (error) {
    if (!(error instanceof MissingSecretError)) {
      throw error;
    }
    console.error({ event: "sync.skipped", kind: "trakt", reason: "skip.missing_secret" });
    return null;
  }
}

// Logs a kind's failure so the other kind still runs.
async function contained(
  kind: TraktKind,
  run: Promise<SyncResult | null>,
): Promise<SyncResult | null> {
  try {
    return await run;
  } catch (error) {
    console.error({ event: "sync.failed", kind, error: String(error) });
    return null;
  }
}
