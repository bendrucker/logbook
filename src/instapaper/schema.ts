import { z } from "zod";

// Instapaper documents booleans as the strings "0" and "1". The numbers are
// accepted too, since nothing live has confirmed the spelling.
const flag = z
  .union([z.enum(["0", "1"]), z.literal(0), z.literal(1)])
  .transform((value) => value === "1" || value === 1);

const id = z.number().int().nonnegative();

// A Unix timestamp in seconds.
const seconds = z.number().nonnegative();

export const user = z.object({
  type: z.literal("user"),
  user_id: id,
  username: z.string(),
  subscription_is_active: flag.optional(),
});

export type User = z.infer<typeof user>;

export const bookmark = z.object({
  type: z.literal("bookmark"),
  bookmark_id: id,
  url: z.string(),
  title: z.string(),
  description: z.string(),
  time: seconds,
  starred: flag,
  private_source: z.string(),
  hash: z.string(),
  progress: z.number().min(0).max(1),
  progress_timestamp: seconds,
  tags: z.array(z.object({ id, name: z.string() })).default([]),
});

export type Bookmark = z.infer<typeof bookmark>;

export const highlight = z.object({
  type: z.literal("highlight"),
  highlight_id: id,
  bookmark_id: id,
  text: z.string(),
  note: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  position: z.number().int(),
  time: seconds,
});

export type Highlight = z.infer<typeof highlight>;

export const folder = z.object({
  type: z.literal("folder"),
  folder_id: id,
  title: z.string(),
  display_title: z.string().optional(),
  slug: z.string().optional(),
  sync_to_mobile: z.number().int().optional(),
  position: z.number().optional(),
  public: z.number().int().optional(),
});

export type Folder = z.infer<typeof folder>;

// The standard array can carry a `meta` item beside the objects a method
// returns, so a list keeps only the type it asked for.
function itemsOf<T extends z.ZodType>(item: T, type: string) {
  return z.preprocess(
    (items) => (Array.isArray(items) ? items.filter((each) => typed(each, type)) : items),
    z.array(item),
  );
}

function typed(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}

export const foldersResponse = itemsOf(folder, "folder");

export const highlightsResponse = itemsOf(highlight, "highlight");

export const verifyCredentialsResponse = itemsOf(user, "user");

// `bookmarks/list` answers an object rather than the standard array. The
// documentation calls `delete_ids` a list of IDs without naming a type.
export const bookmarksListResponse = z.object({
  user: user.optional(),
  bookmarks: z.array(bookmark),
  highlights: z.array(highlight).default([]),
  delete_ids: z.array(z.union([id, z.string().regex(/^\d+$/).transform(Number)])).default([]),
});

export type BookmarksList = z.infer<typeof bookmarksListResponse>;

export const errorItem = z.object({
  type: z.literal("error"),
  error_code: z.number().int(),
  message: z.string(),
});

// An error arrives as the standard array holding one error object.
export const errorResponse = z.tuple([errorItem], errorItem);
