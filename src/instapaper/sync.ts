import type { RequestCap } from "../request-cap";
import type { InstapaperKind } from "../sync/kinds";
import { MissingSecretError, recordRun, type Run, type SyncResult } from "../sync/run";
import {
  INVALID_BOOKMARK,
  INVALID_FOLDER,
  InstapaperApiError,
  type InstapaperOptions,
  InstapaperResponseError,
  instapaperPost,
  LIST_LIMIT,
} from "./client";
import type { Credentials } from "./oauth";
import { archiveInstapaperPage, type ListingMode } from "./raw";
import {
  applyFolders,
  applyHighlights,
  applyListing,
  type Listing,
  type ListingApplied,
  type ListingRequest,
  listingFolderId,
  listingWindow,
} from "./rows";
import { bookmarksListResponse, foldersResponse, highlightsResponse } from "./schema";
import { type Known, knownInFolder, knownStarred, markDeleted } from "./store";
import { unhandled } from "../unhandled";

// A full read asks for the next page by sending what it has read so far as
// `have`. The documentation describes `have` as a filter on the newest 500
// rather than a cursor, in which case the second page comes back empty. Should
// it page instead, this bounds a read at 10,000 bookmarks.
export const FULL_READ_PAGES = 20;

export const FOLDERS_WINDOW = "folders";

const SECRETS = [
  "INSTAPAPER_CONSUMER_KEY",
  "INSTAPAPER_CONSUMER_SECRET",
  "INSTAPAPER_ACCESS_TOKEN",
  "INSTAPAPER_ACCESS_SECRET",
] as const;

function secret(env: Env, name: (typeof SECRETS)[number]): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new MissingSecretError(name);
  }
  return value;
}

export function instapaperCredentials(env: Env): Credentials {
  return {
    consumerKey: secret(env, "INSTAPAPER_CONSUMER_KEY"),
    consumerSecret: secret(env, "INSTAPAPER_CONSUMER_SECRET"),
    token: secret(env, "INSTAPAPER_ACCESS_TOKEN"),
    tokenSecret: secret(env, "INSTAPAPER_ACCESS_SECRET"),
  };
}

export interface InstapaperSyncOptions extends Omit<InstapaperOptions, "requests"> {
  now?: Date;
  // Shared by every run in one invocation.
  requests: RequestCap;
}

export interface ListingResult extends SyncResult {
  bookmarkIds: number[];
}

export function syncFolders(env: Env, options: InstapaperSyncOptions): Promise<SyncResult> {
  const kind = "instapaper-bookmarks";
  return recordRun(
    env,
    kind,
    FOLDERS_WINDOW,
    options,
    async (run) => {
      const response = await instapaperPost(
        instapaperCredentials(env),
        "/api/1/folders/list",
        {},
        foldersResponse,
        options,
      );
      await archive(env, kind, FOLDERS_WINDOW, run, 1, response.body);
      const rowsChanged = await applyFolders(env.DB, response.data, run.fetchedAt);
      run.result = { ...run.result, pages: 1, rowsChanged };
    },
    (error, run) => archiveFailure(env, kind, FOLDERS_WINDOW, run, error),
  );
}

// A delta sends every bookmark D1 places in the folder with its hash, so only
// new and changed bookmarks come back and `delete_ids` names the ones that
// left.
export async function syncListing(
  env: Env,
  listing: Listing,
  mode: ListingMode,
  options: InstapaperSyncOptions,
): Promise<ListingResult> {
  const kind = "instapaper-bookmarks";
  const window = listingWindow(listing);
  const bookmarkIds: number[] = [];

  const result = await recordRun(
    env,
    kind,
    window,
    options,
    async (run) => {
      const credentials = instapaperCredentials(env);
      const known = mode === "delta" ? await knownFor(env.DB, listing) : [];
      // The hash alone. Instapaper also takes progress in `have` and writes it
      // back to the account when it is newer, which a mirror must never do.
      let have = known.map((each) => `${each.bookmarkId}:${each.hash}`);
      let page = 1;
      for (;;) {
        const request = { mode, have: have.length };
        // oxlint-disable-next-line no-await-in-loop -- each page's `have` depends on the last
        const applied = await readListingPage(
          env,
          listing,
          credentials,
          have,
          request,
          run,
          page,
          options,
        );
        const fresh = applied.bookmarkIds.filter((id) => !bookmarkIds.includes(id));
        bookmarkIds.push(...fresh);
        run.result = {
          ...run.result,
          pages: page,
          rowsChanged: run.result.rowsChanged + applied.rowsChanged,
        };

        if (mode === "delta") {
          return;
        }
        // Only a full page leads to another, so an empty one after it means
        // `have` filtered the same 500 rather than paging past them, and the
        // folder holds more than the listing reaches.
        if (fresh.length === 0) {
          run.result = { ...run.result, truncated: page > 1 };
          return;
        }
        if (applied.bookmarkIds.length < LIST_LIMIT) {
          return;
        }
        if (page === FULL_READ_PAGES) {
          run.result = { ...run.result, truncated: true };
          return;
        }
        have = bookmarkIds.map(String);
        page += 1;
      }
    },
    (error, run) => archiveFailure(env, kind, window, run, error),
  );

  return { ...result, bookmarkIds };
}

async function readListingPage(
  env: Env,
  listing: Listing,
  credentials: Credentials,
  have: readonly string[],
  request: ListingRequest,
  run: Run,
  page: number,
  options: InstapaperSyncOptions,
): Promise<ListingApplied> {
  const window = listingWindow(listing);
  try {
    const response = await instapaperPost(
      credentials,
      "/api/1/bookmarks/list",
      { folder_id: listingFolderId(listing), limit: String(LIST_LIMIT), have: have.join(",") },
      bookmarksListResponse,
      options,
    );
    await archive(env, "instapaper-bookmarks", window, run, page, response.body, request);
    return await applyListing(env.DB, listing, response.data, request, run.fetchedAt);
  } catch (error) {
    // A folder deleted since `folders/list` read it lists nothing, and its
    // bookmarks turn up in the archive.
    if (!(error instanceof InstapaperApiError) || error.code !== INVALID_FOLDER) {
      throw error;
    }
    await archive(
      env,
      "instapaper-bookmarks",
      window,
      run,
      page,
      error.body,
      request,
      error.status,
    );
    return { rowsChanged: 0, bookmarkIds: [] };
  }
}

function knownFor(db: D1Database, listing: Listing): Promise<Known[]> {
  switch (listing.folder) {
    case "starred":
      return knownStarred(db);
    case "folder":
      return knownInFolder(db, "folder", listing.folderId);
    case "unread":
    case "archive":
      return knownInFolder(db, listing.folder, null);
    default:
      throw unhandled(listing);
  }
}

// A bookmark's highlights come one list per bookmark, complete, so the list
// also settles which highlights were deleted.
export function syncHighlights(
  env: Env,
  bookmarkId: number,
  options: InstapaperSyncOptions,
): Promise<SyncResult> {
  const kind = "instapaper-highlights";
  const window = String(bookmarkId);
  return recordRun(
    env,
    kind,
    window,
    options,
    async (run) => {
      try {
        const response = await instapaperPost(
          instapaperCredentials(env),
          `/api/1.1/bookmarks/${bookmarkId}/highlights`,
          {},
          highlightsResponse,
          options,
        );
        await archive(env, kind, window, run, 1, response.body);
        const rowsChanged = await applyHighlights(env.DB, bookmarkId, response.data);
        run.result = { ...run.result, pages: 1, rowsChanged };
      } catch (error) {
        // An ID Instapaper no longer recognizes belongs to a deleted bookmark,
        // which is an answer about the bookmark rather than a failed read.
        if (!(error instanceof InstapaperApiError) || error.code !== INVALID_BOOKMARK) {
          throw error;
        }
        await archive(env, kind, window, run, 1, error.body, undefined, error.status);
        const rowsChanged = await markDeleted(env.DB, bookmarkId, run.fetchedAt);
        run.result = { ...run.result, pages: 1, rowsChanged };
      }
    },
    (error, run) => archiveFailure(env, kind, window, run, error),
  );
}

function archive(
  env: Env,
  kind: InstapaperKind,
  window: string,
  run: Run,
  page: number,
  body: string,
  listing?: ListingRequest,
  status = 200,
): Promise<boolean> {
  return archiveInstapaperPage(env.RAW, {
    kind,
    window,
    fetchedAt: run.fetchedAt,
    page,
    body,
    status,
    ...(listing === undefined ? {} : { listing }),
  });
}

// A failure carrying bytes lands as the page the fetch never got to.
async function archiveFailure(
  env: Env,
  kind: InstapaperKind,
  window: string,
  run: Run,
  error: unknown,
): Promise<void> {
  if (error instanceof InstapaperResponseError) {
    await archiveInstapaperPage(env.RAW, {
      kind,
      window,
      fetchedAt: run.fetchedAt,
      page: run.result.pages + 1,
      body: error.body,
      status: error.status,
      failure: error.name,
    });
  }
}
