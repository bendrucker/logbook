import { describe, expect, it } from "vitest";
import { bookmarksListResponse } from "./schema";

describe("bookmarksListResponse", () => {
  it.each<{ name: string; deleteIds: unknown; expected: number[] }>([
    { name: "an array of numbers", deleteIds: [12, 34], expected: [12, 34] },
    { name: "an array of digit strings", deleteIds: ["12", "34"], expected: [12, 34] },
    { name: "a comma-separated string", deleteIds: "12,34", expected: [12, 34] },
    { name: "an empty string", deleteIds: "", expected: [] },
    { name: "a missing field", deleteIds: undefined, expected: [] },
  ])("reads delete_ids given as $name", ({ deleteIds, expected }) => {
    const parsed = bookmarksListResponse.parse({ bookmarks: [], delete_ids: deleteIds });

    expect(parsed.delete_ids).toEqual(expected);
  });
});
