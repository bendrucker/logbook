import { integer, text, timestamp } from "./columns";
import type { LakeTable } from "./table";

export const issues: LakeTable = {
  name: "issues",
  path: "github/v1/issues",
  key: ["id"],
  columns: [
    text("id"),
    text("repository_id"),
    integer("number"),
    text("title"),
    text("author"),
    timestamp("created_at"),
    timestamp("closed_at"),
    text("state"),
    integer("comment_count"),
    timestamp("updated_at"),
  ],
};
