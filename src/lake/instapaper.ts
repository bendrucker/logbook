import { bigint, boolean, double, integer, text, timestamp } from "./columns";
import type { LakeTable } from "./table";

export const instapaperBookmarks: LakeTable = {
  name: "instapaper_bookmarks",
  path: "instapaper/v1/bookmarks",
  key: ["bookmark_id"],
  columns: [
    bigint("bookmark_id"),
    text("url"),
    text("title"),
    text("description"),
    timestamp("saved_at"),
    boolean("starred"),
    text("folder"),
    bigint("folder_id"),
    double("progress"),
    timestamp("progress_at"),
    text("private_source"),
    text("tags"),
    text("hash"),
    timestamp("unlisted_at"),
    timestamp("deleted_at"),
    timestamp("fetched_at"),
  ],
};

export const instapaperHighlights: LakeTable = {
  name: "instapaper_highlights",
  path: "instapaper/v1/highlights",
  key: ["highlight_id"],
  columns: [
    bigint("highlight_id"),
    bigint("bookmark_id"),
    text("text"),
    text("note"),
    integer("position"),
    timestamp("created_at"),
  ],
};

export const instapaperFolders: LakeTable = {
  name: "instapaper_folders",
  path: "instapaper/v1/folders",
  key: ["folder_id"],
  columns: [
    bigint("folder_id"),
    text("title"),
    text("slug"),
    double("position"),
    boolean("public"),
    timestamp("fetched_at"),
  ],
};
