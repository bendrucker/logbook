import { LIST_LIMIT } from "./client";
import type { ListingMode } from "./raw";
import type { Bookmark, BookmarksList, Folder, Highlight } from "./schema";
import {
  type BookmarkRow,
  type FolderName,
  type FolderRow,
  type HighlightRow,
  markUnlisted,
  markUnstarred,
  pruneFolders,
  pruneHighlights,
  upsertBookmarks,
  upsertFolders,
  upsertHighlights,
} from "./store";
import { unhandled } from "../unhandled";

export type Listing =
  | { folder: "unread" | "archive" | "starred" }
  | { folder: "folder"; folderId: number };

export function listingWindow(listing: Listing): string {
  return listing.folder === "folder" ? `folder-${listing.folderId}` : listing.folder;
}

export function parseListingWindow(window: string): Listing | null {
  if (window === "unread" || window === "archive" || window === "starred") {
    return { folder: window };
  }
  const match = /^folder-(\d+)$/.exec(window);
  return match === null ? null : { folder: "folder", folderId: Number(match[1]) };
}

// The `folder_id` parameter `bookmarks/list` takes.
export function listingFolderId(listing: Listing): string {
  return listing.folder === "folder" ? String(listing.folderId) : listing.folder;
}

function placement(listing: Listing): { folder: FolderName | null; folderId: number | null } {
  switch (listing.folder) {
    case "starred":
      return { folder: null, folderId: null };
    case "folder":
      return { folder: "folder", folderId: listing.folderId };
    case "unread":
    case "archive":
      return { folder: listing.folder, folderId: null };
    default:
      throw unhandled(listing);
  }
}

function instant(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function orNull(value: string): string | null {
  return value === "" ? null : value;
}

export function bookmarkRow(bookmark: Bookmark, listing: Listing, fetchedAt: string): BookmarkRow {
  return {
    bookmarkId: bookmark.bookmark_id,
    url: bookmark.url,
    title: bookmark.title,
    description: orNull(bookmark.description),
    savedAt: instant(bookmark.time),
    starred: bookmark.starred,
    ...placement(listing),
    progress: bookmark.progress,
    // Zero for a bookmark nobody has opened.
    progressAt: bookmark.progress_timestamp === 0 ? null : instant(bookmark.progress_timestamp),
    privateSource: orNull(bookmark.private_source),
    tags: JSON.stringify(bookmark.tags.map((tag) => tag.name)),
    hash: bookmark.hash,
    fetchedAt,
  };
}

export function highlightRow(highlight: Highlight): HighlightRow {
  return {
    highlightId: highlight.highlight_id,
    bookmarkId: highlight.bookmark_id,
    text: highlight.text,
    note: highlight.note === null ? null : orNull(highlight.note),
    position: highlight.position,
    createdAt: instant(highlight.time),
  };
}

export function folderRow(folder: Folder, fetchedAt: string): FolderRow {
  return {
    folderId: folder.folder_id,
    title: folder.title,
    slug: folder.slug ?? null,
    position: folder.position ?? null,
    public: folder.public === undefined ? null : folder.public === 1,
    fetchedAt,
  };
}

export interface ListingRequest {
  mode: ListingMode;
  // How many bookmarks the request sent as `have`.
  have: number;
}

export interface ListingApplied {
  rowsChanged: number;
  // IDs of the bookmarks the page returned, whose highlights may have changed.
  bookmarkIds: number[];
}

// Bookmarks land before their highlights and before `delete_ids` is read, so a
// bookmark this page moved into the folder is not marked as having left it.
export async function applyListing(
  db: D1Database,
  listing: Listing,
  data: BookmarksList,
  request: ListingRequest,
  fetchedAt: string,
): Promise<ListingApplied> {
  let rowsChanged = await upsertBookmarks(
    db,
    data.bookmarks.map((bookmark) => bookmarkRow(bookmark, listing, fetchedAt)),
  );
  rowsChanged += await upsertHighlights(db, data.highlights.map(highlightRow));

  // A full read's `have` holds the pages it already read, so its `delete_ids`
  // says nothing about what left the folder.
  if (request.mode === "delta") {
    if (listing.folder === "starred") {
      // Past the limit, a bookmark still starred can drop out of the window as
      // a newer one is starred, and `delete_ids` stops meaning unstarred.
      if (request.have + data.bookmarks.length <= LIST_LIMIT) {
        rowsChanged += await markUnstarred(db, data.delete_ids);
      }
    } else {
      const { folder, folderId } = placement(listing);
      if (folder !== null) {
        rowsChanged += await markUnlisted(db, folder, folderId, data.delete_ids, fetchedAt);
      }
    }
  }

  return { rowsChanged, bookmarkIds: data.bookmarks.map((bookmark) => bookmark.bookmark_id) };
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
    highlights.map((highlight) => highlight.highlight_id),
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
    folders.map((folder) => folder.folder_id),
  );
  return upserted + pruned;
}
