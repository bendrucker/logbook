import { integer, text, timestamp } from "./columns";
import type { LakeTable } from "./table";

export const pullRequests: LakeTable = {
  name: "pull_requests",
  path: "github/v1/pull_requests",
  key: ["id"],
  columns: [
    text("id"),
    text("repository_id"),
    integer("number"),
    text("title"),
    text("author"),
    timestamp("created_at"),
    timestamp("merged_at"),
    timestamp("closed_at"),
    text("state"),
    integer("additions"),
    integer("deletions"),
    integer("changed_files"),
    integer("comment_count"),
    integer("review_count"),
    timestamp("updated_at"),
  ],
};
