import { type BindValue, upsertWriter } from "../store/upsert";

export interface BookmarkRow {
  bookmarkId: number;
  url: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  author: string | null;
  articlePublishedAt: string | null;
  savedAt: string;
  liked: boolean;
  archived: boolean;
  folderId: number | null;
  progress: number;
  progressAt: string | null;
  privateSource: string | null;
  category: number;
  tags: string;
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
  slug: string;
  position: number;
  public: boolean;
  fetchedAt: string;
}

const bookmarkColumns = [
  "bookmark_id",
  "url",
  "title",
  "description",
  "image",
  "author",
  "article_published_at",
  "saved_at",
  "liked",
  "archived",
  "folder_id",
  "progress",
  "progress_at",
  "private_source",
  "category",
  "tags",
  "deleted_at",
  "fetched_at",
] as const;

// A bookmark a listing returns exists, so `deleted_at` binds null and clears.
export const upsertBookmarks = upsertWriter(
  {
    table: "instapaper_bookmarks",
    columns: bookmarkColumns,
    conflict: ["bookmark_id"],
    compared: bookmarkColumns.filter(
      (column) => column !== "bookmark_id" && column !== "fetched_at",
    ),
  },
  (row: BookmarkRow): Record<(typeof bookmarkColumns)[number], BindValue> => ({
    bookmark_id: row.bookmarkId,
    url: row.url,
    title: row.title,
    description: row.description,
    image: row.image,
    author: row.author,
    article_published_at: row.articlePublishedAt,
    saved_at: row.savedAt,
    liked: Number(row.liked),
    archived: Number(row.archived),
    folder_id: row.folderId,
    progress: row.progress,
    progress_at: row.progressAt,
    private_source: row.privateSource,
    category: row.category,
    tags: row.tags,
    deleted_at: null,
    fetched_at: row.fetchedAt,
  }),
);

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
    public: Number(row.public),
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

// The folder list is complete, and deleting a folder moves its bookmarks back
// to Home, which the change listing reports.
export async function pruneFolders(db: D1Database, kept: readonly number[]): Promise<number> {
  const result = await db
    .prepare(
      "DELETE FROM instapaper_folders WHERE folder_id NOT IN (SELECT value FROM json_each(?1))",
    )
    .bind(JSON.stringify(kept))
    .run();
  return result.meta.changes;
}

export async function markDeleted(
  db: D1Database,
  bookmarkIds: readonly number[],
  at: string,
): Promise<number> {
  if (bookmarkIds.length === 0) {
    return 0;
  }
  const result = await db
    .prepare(
      "UPDATE instapaper_bookmarks SET deleted_at = ?2" +
        " WHERE bookmark_id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL",
    )
    .bind(JSON.stringify(bookmarkIds), at)
    .run();
  return result.meta.changes;
}

export async function liveBookmarkIds(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare(
      "SELECT bookmark_id FROM instapaper_bookmarks WHERE deleted_at IS NULL ORDER BY bookmark_id",
    )
    .all<{ bookmark_id: number }>();
  return results.map((row) => row.bookmark_id);
}
