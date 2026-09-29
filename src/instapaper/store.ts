import { type BindValue, upsertWriter } from "../store/upsert";

// Where a listing found a bookmark. Starred is a view across the others rather
// than a place a bookmark lives.
export type FolderName = "unread" | "archive" | "folder";

export interface BookmarkRow {
  bookmarkId: number;
  url: string;
  title: string;
  description: string | null;
  savedAt: string;
  starred: boolean;
  // Null when the listing that returned it says nothing about its folder.
  folder: FolderName | null;
  folderId: number | null;
  progress: number;
  progressAt: string | null;
  privateSource: string | null;
  tags: string;
  hash: string;
  fetchedAt: string;
}

export interface HighlightRow {
  highlightId: number;
  bookmarkId: number;
  text: string;
  note: string | null;
  position: number;
  createdAt: string;
}

export interface FolderRow {
  folderId: number;
  title: string;
  slug: string | null;
  position: number | null;
  public: boolean | null;
  fetchedAt: string;
}

const bookmarkColumns = [
  "bookmark_id",
  "url",
  "title",
  "description",
  "saved_at",
  "starred",
  "folder",
  "folder_id",
  "progress",
  "progress_at",
  "private_source",
  "tags",
  "hash",
  "fetched_at",
] as const;

const described = [
  "url",
  "title",
  "description",
  "saved_at",
  "starred",
  "progress",
  "progress_at",
  "private_source",
  "tags",
  "hash",
] as const;

// A listing of a folder places the bookmark there and clears `unlisted_at`.
// The starred listing leaves both alone, since a starred bookmark lives in some
// other folder it does not name. A bookmark any listing returns exists, so
// `deleted_at` clears either way. `fetched_at` moves with any change but never
// causes one.
const upsertBookmarkSql = [
  `INSERT INTO instapaper_bookmarks (${bookmarkColumns.join(", ")})`,
  `VALUES (${bookmarkColumns.map((_, index) => `?${index + 1}`).join(", ")})`,
  "ON CONFLICT (bookmark_id) DO UPDATE SET",
  [
    ...described.map((column) => `${column} = excluded.${column}`),
    "folder = COALESCE(excluded.folder, instapaper_bookmarks.folder)",
    "folder_id = CASE WHEN excluded.folder IS NULL THEN instapaper_bookmarks.folder_id ELSE excluded.folder_id END",
    "unlisted_at = CASE WHEN excluded.folder IS NULL THEN instapaper_bookmarks.unlisted_at ELSE NULL END",
    "deleted_at = NULL",
    "fetched_at = excluded.fetched_at",
  ].join(", "),
  "WHERE",
  [
    ...described.map((column) => `instapaper_bookmarks.${column} IS NOT excluded.${column}`),
    "(excluded.folder IS NOT NULL AND (instapaper_bookmarks.folder IS NOT excluded.folder" +
      " OR instapaper_bookmarks.folder_id IS NOT excluded.folder_id" +
      " OR instapaper_bookmarks.unlisted_at IS NOT NULL))",
    "instapaper_bookmarks.deleted_at IS NOT NULL",
  ].join(" OR "),
].join(" ");

export async function upsertBookmarks(
  db: D1Database,
  rows: readonly BookmarkRow[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const statement = db.prepare(upsertBookmarkSql);
  const results = await db.batch(
    rows.map((row) =>
      statement.bind(
        row.bookmarkId,
        row.url,
        row.title,
        row.description,
        row.savedAt,
        row.starred ? 1 : 0,
        row.folder,
        row.folderId,
        row.progress,
        row.progressAt,
        row.privateSource,
        row.tags,
        row.hash,
        row.fetchedAt,
      ),
    ),
  );
  return changes(results);
}

const highlightColumns = [
  "highlight_id",
  "bookmark_id",
  "text",
  "note",
  "position",
  "created_at",
] as const;

export const upsertHighlights = upsertWriter(
  { table: "instapaper_highlights", columns: highlightColumns, conflict: ["highlight_id"] },
  (row: HighlightRow): Record<(typeof highlightColumns)[number], BindValue> => ({
    highlight_id: row.highlightId,
    bookmark_id: row.bookmarkId,
    text: row.text,
    note: row.note,
    position: row.position,
    created_at: row.createdAt,
  }),
);

const folderColumns = ["folder_id", "title", "slug", "position", "public", "fetched_at"] as const;

export const upsertFolders = upsertWriter(
  {
    table: "instapaper_folders",
    columns: folderColumns,
    conflict: ["folder_id"],
    compared: ["title", "slug", "position", "public"],
  },
  (row: FolderRow): Record<(typeof folderColumns)[number], BindValue> => ({
    folder_id: row.folderId,
    title: row.title,
    slug: row.slug,
    position: row.position,
    public: row.public === null ? null : row.public ? 1 : 0,
    fetched_at: row.fetchedAt,
  }),
);

// A bookmark's highlight list is complete, so a highlight D1 holds that the
// list leaves out was deleted.
export async function pruneHighlights(
  db: D1Database,
  bookmarkId: number,
  kept: readonly number[],
): Promise<number> {
  const result = await db
    .prepare(
      "DELETE FROM instapaper_highlights WHERE bookmark_id = ?1" +
        " AND highlight_id NOT IN (SELECT value FROM json_each(?2))",
    )
    .bind(bookmarkId, JSON.stringify(kept))
    .run();
  return result.meta.changes;
}

// The folder list is complete, and deleting a folder moves its bookmarks to
// the archive, where the archive listing finds them.
export async function pruneFolders(db: D1Database, kept: readonly number[]): Promise<number> {
  const result = await db
    .prepare(
      "DELETE FROM instapaper_folders WHERE folder_id NOT IN (SELECT value FROM json_each(?1))",
    )
    .bind(JSON.stringify(kept))
    .run();
  return result.meta.changes;
}

// Only a bookmark D1 still places in the listed folder, since one a listing of
// its new folder already returned has moved rather than left.
export async function markUnlisted(
  db: D1Database,
  folder: FolderName,
  folderId: number | null,
  bookmarkIds: readonly number[],
  at: string,
): Promise<number> {
  if (bookmarkIds.length === 0) {
    return 0;
  }
  const result = await db
    .prepare(
      "UPDATE instapaper_bookmarks SET unlisted_at = ?4" +
        " WHERE bookmark_id IN (SELECT value FROM json_each(?1))" +
        " AND folder = ?2 AND folder_id IS ?3 AND unlisted_at IS NULL",
    )
    .bind(JSON.stringify(bookmarkIds), folder, folderId, at)
    .run();
  return result.meta.changes;
}

export async function markUnstarred(
  db: D1Database,
  bookmarkIds: readonly number[],
): Promise<number> {
  if (bookmarkIds.length === 0) {
    return 0;
  }
  const result = await db
    .prepare(
      "UPDATE instapaper_bookmarks SET starred = 0" +
        " WHERE bookmark_id IN (SELECT value FROM json_each(?1)) AND starred = 1",
    )
    .bind(JSON.stringify(bookmarkIds))
    .run();
  return result.meta.changes;
}

export async function markDeleted(db: D1Database, bookmarkId: number, at: string): Promise<number> {
  const result = await db
    .prepare(
      "UPDATE instapaper_bookmarks SET deleted_at = ?2 WHERE bookmark_id = ?1 AND deleted_at IS NULL",
    )
    .bind(bookmarkId, at)
    .run();
  return result.meta.changes;
}

export interface Known {
  bookmarkId: number;
  hash: string;
}

// What a delta listing of the folder sends as `have`: every bookmark D1 places
// in its window.
export async function knownInFolder(
  db: D1Database,
  folder: FolderName,
  folderId: number | null,
): Promise<Known[]> {
  const { results } = await db
    .prepare(
      "SELECT bookmark_id, hash FROM instapaper_bookmarks" +
        " WHERE folder = ?1 AND folder_id IS ?2 AND unlisted_at IS NULL AND deleted_at IS NULL" +
        " ORDER BY bookmark_id",
    )
    .bind(folder, folderId)
    .all<{ bookmark_id: number; hash: string }>();
  return results.map((row) => ({ bookmarkId: row.bookmark_id, hash: row.hash }));
}

export async function knownStarred(db: D1Database): Promise<Known[]> {
  const { results } = await db
    .prepare(
      "SELECT bookmark_id, hash FROM instapaper_bookmarks" +
        " WHERE starred = 1 AND deleted_at IS NULL ORDER BY bookmark_id",
    )
    .all<{ bookmark_id: number; hash: string }>();
  return results.map((row) => ({ bookmarkId: row.bookmark_id, hash: row.hash }));
}

export async function liveBookmarkIds(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare(
      "SELECT bookmark_id FROM instapaper_bookmarks WHERE deleted_at IS NULL ORDER BY bookmark_id",
    )
    .all<{ bookmark_id: number }>();
  return results.map((row) => row.bookmark_id);
}

export async function userFolderIds(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT folder_id FROM instapaper_folders ORDER BY folder_id")
    .all<{ folder_id: number }>();
  return results.map((row) => row.folder_id);
}

function changes(results: readonly D1Result[]): number {
  return results.reduce((total, result) => total + result.meta.changes, 0);
}
