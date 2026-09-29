import { RequestCap } from "../request-cap";
import { MissingSecretError } from "../sync/run";
import { advance, readWatermark } from "../sync/state";
import { drainInstapaper, type InstapaperInvocationOptions, requeueHighlights } from "./backfill";
import { instapaperToken, type InstapaperSyncOptions, syncChanges, syncFolders } from "./sync";

// Reads open this far behind the watermark, so a change stamped by a clock
// running behind the Worker's still lands in the next listing.
const SKEW_MS = 5 * 60 * 1000;

// A cap or a 429 applies to the whole application, so the first stop ends the
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

// True when a limit stopped the pass. The watermark moves only when the whole
// listing landed, so it names the last pass that saw every change.
async function syncBookmarks(
  env: Env,
  options: InstapaperSyncOptions,
  started: Date,
): Promise<boolean> {
  const watermark = await readWatermark(env.DB, "instapaper-bookmarks");
  if (watermark === null) {
    // A listing from nothing would read the whole account, which is what a
    // backfill does under a frontier that survives a limit.
    console.log("instapaper-bookmarks has no watermark, so a backfill owns its first read");
    return false;
  }

  const folders = await syncFolders(env, options);
  if (folders.error !== null) {
    return folders.resumeAt !== null;
  }

  const since = new Date(new Date(watermark.window).getTime() - SKEW_MS);
  const changes = await syncChanges(env, since, options);
  // What a failed listing landed before it stopped still has its highlights read.
  await requeueHighlights(env.DB, changes.bookmarkIds, started.toISOString());
  if (changes.error === null) {
    await advance(env.DB, "instapaper-bookmarks", started.toISOString());
  }
  return changes.resumeAt !== null;
}

// A cron that throws only retries on the next hour, and no amount of retrying
// sets a secret.
function configured(env: Env): boolean {
  try {
    instapaperToken(env);
    return true;
  } catch (error) {
    if (!(error instanceof MissingSecretError)) {
      throw error;
    }
    console.error(error.message);
    return false;
  }
}
