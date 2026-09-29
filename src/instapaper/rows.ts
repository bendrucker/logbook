import type { Bookmark, Changes, Folder, Highlight } from "./schema";
import {
  type BookmarkRow,
  type FolderRow,
  type HighlightRow,
  markDeleted,
  pruneFolders,
  pruneHighlights,
  upsertBookmarks,
  upsertFolders,
  upsertHighlights,
} from "./store";

function instant(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function orNull(value: string | null): string | null {
  return value === "" ? null : value;
}

export function bookmarkRow(bookmark: Bookmark, fetchedAt: string): BookmarkRow {
  return {
    bookmarkId: bookmark.id,
    url: orNull(bookmark.url),
    title: orNull(bookmark.title),
    description: orNull(bookmark.description),
    image: orNull(bookmark.image),
    author: orNull(bookmark.author),
    articlePublishedAt: bookmark.pubtime === null ? null : instant(bookmark.pubtime),
    savedAt: instant(bookmark.time),
    liked: bookmark.liked,
    archived: bookmark.archived,
    folderId: bookmark.folder_id,
    progress: bookmark.progress.percentage,
    // Zero for a bookmark nobody has opened.
    progressAt: bookmark.progress.timestamp === 0 ? null : instant(bookmark.progress.timestamp),
    privateSource: orNull(bookmark.private_source),
    category: bookmark.category,
    tags: JSON.stringify(bookmark.tags.map((tag) => tag.name)),
    fetchedAt,
  };
}

export function highlightRow(highlight: Highlight): HighlightRow {
  return {
    highlightId: highlight.id,
    bookmarkId: highlight.bookmark_id,
    text: highlight.text,
    note: orNull(highlight.note),
    position: highlight.position,
    createdAt: instant(highlight.time),
  };
}

export function folderRow(folder: Folder, fetchedAt: string): FolderRow {
  return {
    folderId: folder.id,
    title: folder.title,
    slug: folder.slug,
    position: folder.position,
    public: folder.public,
    fetchedAt,
  };
}

export async function applyChanges(
  db: D1Database,
  changes: Changes,
  fetchedAt: string,
): Promise<number> {
  const upserted = await upsertBookmarks(
    db,
    changes.bookmarks.map((bookmark) => bookmarkRow(bookmark, fetchedAt)),
  );
  return upserted + (await markDeleted(db, changes.deleted_ids, fetchedAt));
}

export async function applyHighlights(
  db: D1Database,
  bookmarkId: number,
  highlights: readonly Highlight[],
): Promise<number> {
  const upserted = await upsertHighlights(db, highlights.map(highlightRow));
  const pruned = await pruneHighlights(
    db,
    bookmarkId,
    highlights.map((highlight) => highlight.id),
  );
  return upserted + pruned;
}

export async function applyFolders(
  db: D1Database,
  folders: readonly Folder[],
  fetchedAt: string,
): Promise<number> {
  const upserted = await upsertFolders(
    db,
    folders.map((folder) => folderRow(folder, fetchedAt)),
  );
  const pruned = await pruneFolders(
    db,
    folders.map((folder) => folder.id),
  );
  return upserted + pruned;
}
