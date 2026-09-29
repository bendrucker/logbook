import { RequestCap } from "../request-cap";
import { type BackfillResult, unitFetch } from "../sync/backfill";
import { type CrawlSource, type Drain, drain, enqueue, frontierStatus } from "../sync/frontier";
import type { InstapaperKind } from "../sync/kinds";
import { advance } from "../sync/state";
import type { InstapaperOptions } from "./client";
import { type Listing, listingWindow, parseListingWindow } from "./rows";
import { liveBookmarkIds, userFolderIds } from "./store";
import {
  FOLDERS_WINDOW,
  instapaperCredentials,
  type InstapaperSyncOptions,
  syncFolders,
  syncHighlights,
  syncListing,
} from "./sync";

export interface InstapaperInvocationOptions extends Omit<InstapaperOptions, "requests"> {
  now?: Date;
}

// Every listing the account has: the built-in folders, each folder of the
// user's own, and the starred view across them.
export async function listings(db: D1Database): Promise<Listing[]> {
  const folders = await userFolderIds(db);
  return [
    { folder: "unread" },
    { folder: "archive" },
    ...folders.map((folderId): Listing => ({ folder: "folder", folderId })),
    { folder: "starred" },
  ];
}

// A unit already in the frontier keeps its status, so calling again resumes.
// A bookmarks unit is one folder read whole, and a highlights unit is one
// bookmark's highlights.
export async function backfillInstapaper(
  env: Env,
  kind: InstapaperKind,
  options: InstapaperInvocationOptions = {},
): Promise<BackfillResult> {
  // Read before anything else so an unconfigured deployment answers the caller.
  instapaperCredentials(env);
  const now = options.now ?? new Date();
  const requests = new RequestCap(env.RATE_CAP_INSTAPAPER);

  if (kind === "instapaper-bookmarks") {
    // The folder list names the user folders to enqueue.
    const folders = await syncFolders(env, { ...options, now, requests });
    if (folders.error !== null) {
      return {
        ...(await result(env, kind, [FOLDERS_WINDOW], folders.pages, folders.rowsChanged)),
        // Reported pending so a caller looping to completion calls again.
        pending: 1,
        resumeAt: folders.resumeAt,
        error: folders.error,
      };
    }
    const windows = (await listings(env.DB)).map(listingWindow);
    await enqueue(env.DB, kind, windows, now.toISOString());
  } else {
    const ids = await liveBookmarkIds(env.DB);
    await enqueue(env.DB, kind, ids.map(String), now.toISOString());
  }

  // The drain takes the caller's options rather than the fixed `now` above, so
  // each of its runs stamps its own time.
  const drained = await drainInstapaper(env, kind, { ...options, requests });
  return {
    ...(await result(env, kind, drained.windows, drained.pages, drained.rowsChanged)),
    resumeAt: drained.resumeAt,
    error: drained.error,
  };
}

// Once every folder has been read whole, the bookmarks are synced through the
// earliest of those reads and the hourly delta takes over. A folder past the
// listing limit settles irreducible and counts as read, since no further read
// reaches more of it.
export async function drainInstapaper(
  env: Env,
  kind: InstapaperKind,
  options: InstapaperSyncOptions,
): Promise<Drain> {
  const drained = await drain(env.DB, kind, crawlSource(env, kind, options));
  if (kind === "instapaper-bookmarks" && drained.error === null) {
    const read = await env.DB.prepare(
      "SELECT MIN(fetched_at) AS through, SUM(status = 'pending') AS pending FROM crawl_units" +
        " WHERE kind = 'instapaper-bookmarks'",
    ).first<{ through: string | null; pending: number | null }>();
    if (read?.through != null && read.pending === 0) {
      await advance(env.DB, kind, read.through);
    }
  }
  return drained;
}

// A bookmark whose listing came back changed may have gained highlights, so its
// unit goes back to pending whatever status an earlier read left it in.
export async function requeueHighlights(
  db: D1Database,
  bookmarkIds: readonly number[],
  at: string,
): Promise<void> {
  if (bookmarkIds.length === 0) {
    return;
  }
  const statement = db.prepare(
    "INSERT INTO crawl_units (kind, window, parent, status, updated_at)" +
      " VALUES ('instapaper-highlights', ?1, NULL, 'pending', ?2)" +
      " ON CONFLICT (kind, window) DO UPDATE SET status = 'pending', updated_at = excluded.updated_at",
  );
  await db.batch(bookmarkIds.map((id) => statement.bind(String(id), at)));
}

function crawlSource(env: Env, kind: InstapaperKind, options: InstapaperSyncOptions): CrawlSource {
  if (kind === "instapaper-highlights") {
    return {
      fetch: async (window) => unitFetch(await syncHighlights(env, Number(window), options)),
      split: () => [],
    };
  }
  return {
    fetch: async (window) => {
      const listing = parseListingWindow(window);
      if (listing === null) {
        throw new Error(`${window} is not an Instapaper listing`);
      }
      return unitFetch(await syncListing(env, listing, "full", options));
    },
    // A listing has no narrower window to ask for.
    split: () => [],
  };
}

async function result(
  env: Env,
  kind: InstapaperKind,
  windows: string[],
  pages: number,
  rowsChanged: number,
): Promise<BackfillResult> {
  const status = (await frontierStatus(env.DB)).get(kind);
  return {
    kind,
    windows,
    pages,
    rowsChanged,
    pending: status?.pending ?? 0,
    irreducible: status?.irreducible ?? [],
    resumeAt: null,
    error: null,
  };
}
