import { RequestCap } from "../request-cap";
import { MissingSecretError } from "../sync/run";
import { advance, readWatermark } from "../sync/state";
import {
  drainInstapaper,
  type InstapaperInvocationOptions,
  listings,
  requeueHighlights,
} from "./backfill";
import type { Listing } from "./rows";
import {
  instapaperCredentials,
  type InstapaperSyncOptions,
  type ListingResult,
  syncFolders,
  syncListing,
} from "./sync";

// A cap or a 1040 applies to the whole application, so the first stop ends the
// invocation.
export async function syncInstapaper(
  env: Env,
  options: InstapaperInvocationOptions = {},
): Promise<void> {
  if (!configured(env)) {
    return;
  }
  // Each run stamps its own time, so the order pages were fetched in is the
  // order a replay applies them in. The pass's start is what the watermark
  // takes.
  const { now = new Date(), ...client } = options;
  const requests = new RequestCap(env.RATE_CAP_INSTAPAPER);

  let stopped = false;
  try {
    stopped = await syncBookmarks(env, { ...client, requests }, now);
  } catch (error) {
    console.error(`instapaper-bookmarks sync failed: ${String(error)}`);
  }
  if (stopped) {
    return;
  }

  try {
    const bookmarks = await drainInstapaper(env, "instapaper-bookmarks", { ...client, requests });
    if (bookmarks.resumeAt !== null) {
      return;
    }
    await drainInstapaper(env, "instapaper-highlights", { ...client, requests });
  } catch (error) {
    console.error(`instapaper drain failed: ${String(error)}`);
  }
}

// True when a limit stopped the pass. The watermark moves only when every
// listing landed, so it names the last pass that saw the whole account.
async function syncBookmarks(
  env: Env,
  options: InstapaperSyncOptions,
  started: Date,
): Promise<boolean> {
  if ((await readWatermark(env.DB, "instapaper-bookmarks")) === null) {
    // A delta against an empty table reads each folder whole, which is what a
    // backfill does under a frontier that survives a limit.
    console.log("instapaper-bookmarks has no watermark, so a backfill owns its first read");
    return false;
  }

  const folders = await syncFolders(env, options);
  if (folders.error !== null) {
    return folders.resumeAt !== null;
  }

  const remaining = await listings(env.DB);
  const changed: number[] = [];
  let failed = false;
  let stopped = false;
  for (const listing of remaining) {
    // oxlint-disable-next-line no-await-in-loop -- a rate limit on one listing ends the pass
    const result = await syncDelta(env, listing, options, changed);
    if (result.error !== null) {
      failed = true;
      if (result.resumeAt !== null) {
        stopped = true;
        break;
      }
    }
  }

  await requeueHighlights(env.DB, changed, started.toISOString());
  if (!failed) {
    await advance(env.DB, "instapaper-bookmarks", started.toISOString());
  }
  return stopped;
}

// What a failed listing landed before it stopped still has its highlights read.
async function syncDelta(
  env: Env,
  listing: Listing,
  options: InstapaperSyncOptions,
  changed: number[],
): Promise<ListingResult> {
  const result = await syncListing(env, listing, "delta", options);
  changed.push(...result.bookmarkIds.filter((id) => !changed.includes(id)));
  return result;
}

// A cron that throws only retries on the next hour, and no amount of retrying
// sets a secret.
function configured(env: Env): boolean {
  try {
    instapaperCredentials(env);
    return true;
  } catch (error) {
    if (!(error instanceof MissingSecretError)) {
      throw error;
    }
    console.error(error.message);
    return false;
  }
}
