import { z } from "zod";

const id = z.number().int().nonnegative();

// A Unix timestamp in seconds.
const seconds = z.number().nonnegative();

export const bookmark = z.object({
  id,
  url: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  progress: z.object({ percentage: z.number().min(0).max(1), timestamp: seconds }),
  liked: z.boolean(),
  archived: z.boolean(),
  time: seconds,
  pubtime: seconds.nullable(),
  author: z.string().nullable(),
  folder_id: id.nullable(),
  tags: z.array(z.object({ name: z.string() })),
  private_source: z.string().nullable(),
  category: z.number().int(),
});

export type Bookmark = z.infer<typeof bookmark>;

// A page of `GET /bookmarks?since=`, where changed bookmarks and deleted IDs
// share the page size.
export const changesResponse = z.object({
  bookmarks: z.array(bookmark),
  deleted_ids: z.array(id).default([]),
});

export type Changes = z.infer<typeof changesResponse>;

export const highlight = z.object({
  id,
  bookmark_id: id,
  text: z.string(),
  note: z.string().nullable(),
  position: z.number().int(),
  time: seconds,
});

export type Highlight = z.infer<typeof highlight>;

export const highlightsResponse = z.object({ highlights: z.array(highlight) });

export const folder = z.object({
  id,
  title: z.string(),
  slug: z.string(),
  position: z.number().int(),
  public: z.boolean(),
});

export type Folder = z.infer<typeof folder>;

export const foldersResponse = z.object({ folders: z.array(folder) });
