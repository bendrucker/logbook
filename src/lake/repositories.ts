import { boolean, integer, text, timestamp } from "./columns";
import type { LakeTable } from "./table";

// `published_at` stays out of every table here. It is the publisher's queue
// marker rather than something GitHub said, and it moves without the row's
// meaning changing.
export const repositories: LakeTable = {
  name: "repositories",
  path: "github/v1/repositories",
  key: ["id"],
  columns: [
    text("id"),
    text("owner"),
    text("name"),
    text("description"),
    text("url"),
    integer("stargazer_count"),
    text("primary_language"),
    text("primary_language_color"),
    timestamp("created_at"),
    boolean("is_fork"),
    text("visibility"),
    timestamp("fetched_at"),
  ],
};
