import type { RequestCap } from "../request-cap";
import type { InstapaperKind } from "../sync/kinds";
import { MissingSecretError, recordRun, type Run, type SyncResult } from "../sync/run";
import {
  InstapaperClient,
  type InstapaperOptions,
  InstapaperResponseError,
  PAGE_SIZE,
} from "./client";
import { archiveInstapaperPage } from "./raw";
import { applyChanges, applyFolders, applyHighlights } from "./rows";

export const FOLDERS_WINDOW = "folders";
export const CHANGES_WINDOW = "changes";

// The earliest `since` the API accepts, which reads the whole account.
export const EVERYTHING = new Date(1000);

export function instapaperToken(env: Env): string {
  const token = env.INSTAPAPER_ACCESS_TOKEN;
  if (token === undefined || token === "") {
    throw new MissingSecretError("INSTAPAPER_ACCESS_TOKEN");
  }
  return token;
}

export interface InstapaperSyncOptions extends Omit<InstapaperOptions, "requests"> {
  now?: Date;
  // Shared by every run in one invocation.
  requests: RequestCap;
}

export interface ChangesResult extends SyncResult {
  // Bookmarks the listing returned, whose highlights may have changed.
  bookmarkIds: number[];
}

function client(env: Env, options: InstapaperSyncOptions): InstapaperClient {
  return new InstapaperClient(instapaperToken(env), options);
}

export function syncFolders(env: Env, options: InstapaperSyncOptions): Promise<SyncResult> {
  const kind = "instapaper-bookmarks";
  return recordRun(
    env,
    kind,
    FOLDERS_WINDOW,
    options,
    async (run) => {
      const response = await client(env, options).folders();
      await archive(env, kind, FOLDERS_WINDOW, run, 1, response.body);
      const rowsChanged = await applyFolders(env.DB, response.data.folders, run.fetchedAt);
      run.result = { ...run.result, pages: 1, rowsChanged };
    },
    (error, run) => archiveFailure(env, kind, FOLDERS_WINDOW, run, error),
  );
}

// Every bookmark changed since `since` across Home, the Archive, and every
// folder, with the IDs of those deleted. Changed bookmarks and deleted IDs
// share each page, so the offset advances by both and a short page is the
// last.
export async function syncChanges(
  env: Env,
  since: Date,
  options: InstapaperSyncOptions,
): Promise<ChangesResult> {
  const kind = "instapaper-bookmarks";
  const bookmarkIds = new Set<number>();
  const seconds = Math.max(1, Math.floor(since.getTime() / 1000));

  const result = await recordRun(
    env,
    kind,
    CHANGES_WINDOW,
    options,
    async (run) => {
      const instapaper = client(env, options);
      let offset = 0;
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- each page's offset depends on the last
        const received = await readChangesPage(env, instapaper, seconds, offset, run, bookmarkIds);
        if (received < PAGE_SIZE) {
          return;
        }
        offset += received;
      }
    },
    (error, run) => archiveFailure(env, kind, CHANGES_WINDOW, run, error),
  );

  return { ...result, bookmarkIds: [...bookmarkIds] };
}

// Answers how many bookmarks and deleted IDs the page held.
async function readChangesPage(
  env: Env,
  instapaper: InstapaperClient,
  since: number,
  offset: number,
  run: Run,
  bookmarkIds: Set<number>,
): Promise<number> {
  const page = run.result.pages + 1;
  const response = await instapaper.changes(since, offset);
  await archive(env, "instapaper-bookmarks", CHANGES_WINDOW, run, page, response.body);
  const rowsChanged = await applyChanges(env.DB, response.data, run.fetchedAt);
  for (const bookmark of response.data.bookmarks) {
    bookmarkIds.add(bookmark.id);
  }
  run.result = { ...run.result, pages: page, rowsChanged: run.result.rowsChanged + rowsChanged };
  return response.data.bookmarks.length + response.data.deleted_ids.length;
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
      const response = await client(env, options).highlights(bookmarkId);
      await archive(env, kind, window, run, 1, response.body);
      const rowsChanged = await applyHighlights(env.DB, bookmarkId, response.data.highlights);
      run.result = { ...run.result, pages: 1, rowsChanged };
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
): Promise<boolean> {
  return archiveInstapaperPage(env.RAW, {
    kind,
    window,
    fetchedAt: run.fetchedAt,
    page,
    body,
    status: 200,
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
