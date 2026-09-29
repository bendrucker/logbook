import { integer, text } from "./columns";
import type { LakeTable } from "./table";

// `day` stays the `YYYY-MM-DD` string D1 holds. It is the key of a daily count
// rather than an instant, and dating it would claim a time GitHub never gave.
export const commitDays: LakeTable = {
  name: "commit_days",
  path: "github/v1/commit_days",
  key: ["repository_id", "day"],
  columns: [text("repository_id"), text("day"), integer("commit_count")],
};
