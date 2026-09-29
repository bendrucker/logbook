import { integer, text, timestamp } from "./columns";
import type { LakeTable } from "./table";

export const reviews: LakeTable = {
  name: "reviews",
  path: "github/v1/reviews",
  key: ["id"],
  columns: [
    text("id"),
    text("repository_id"),
    integer("pull_request_number"),
    text("pull_request_author"),
    text("state"),
    timestamp("submitted_at"),
  ],
};
