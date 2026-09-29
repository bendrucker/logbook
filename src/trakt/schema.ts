import { z } from "zod";

// `extended=full` adds these fields. Every one is nullable in Trakt's reference
// and absent from a minimal object, so a missing field reads as null.
const optional = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);

const ids = z.object({
  trakt: z.number().int(),
  slug: optional(z.string()),
  imdb: optional(z.string()),
  tmdb: optional(z.number().int()),
  tvdb: optional(z.number().int()),
});

export const movie = z.object({
  title: z.string(),
  year: optional(z.number().int()),
  ids,
  released: optional(z.string()),
  runtime: optional(z.number().int()),
  genres: optional(z.array(z.string())),
  certification: optional(z.string()),
  country: optional(z.string()),
  language: optional(z.string()),
  status: optional(z.string()),
});

export const show = z.object({
  title: z.string(),
  year: optional(z.number().int()),
  ids,
  first_aired: optional(z.iso.datetime()),
  runtime: optional(z.number().int()),
  genres: optional(z.array(z.string())),
  certification: optional(z.string()),
  network: optional(z.string()),
  country: optional(z.string()),
  language: optional(z.string()),
  status: optional(z.string()),
});

export const season = z.object({
  number: z.number().int(),
  ids,
  title: optional(z.string()),
  first_aired: optional(z.iso.datetime()),
});

export const episode = z.object({
  season: z.number().int(),
  number: z.number().int(),
  title: optional(z.string()),
  ids,
  first_aired: optional(z.iso.datetime()),
  runtime: optional(z.number().int()),
});

export type Movie = z.infer<typeof movie>;
export type Show = z.infer<typeof show>;
export type Season = z.infer<typeof season>;
export type Episode = z.infer<typeof episode>;

const play = {
  // A 64-bit integer, which stays exact in a double until 2^53.
  id: z.number().int().nonnegative(),
  watched_at: z.iso.datetime(),
  action: z.enum(["scrobble", "checkin", "watch"]),
};

export const historyItem = z.discriminatedUnion("type", [
  z.object({ ...play, type: z.literal("movie"), movie }),
  z.object({ ...play, type: z.literal("episode"), episode, show }),
]);

export type HistoryItem = z.infer<typeof historyItem>;

export const historyPage = z.array(historyItem);

const rated = {
  rated_at: z.iso.datetime(),
  rating: z.number().int().min(1).max(10),
};

export const ratingItem = z.discriminatedUnion("type", [
  z.object({ ...rated, type: z.literal("movie"), movie }),
  z.object({ ...rated, type: z.literal("show"), show }),
  z.object({ ...rated, type: z.literal("season"), season, show }),
  z.object({ ...rated, type: z.literal("episode"), episode, show }),
]);

export type RatingItem = z.infer<typeof ratingItem>;

export const ratingsPage = z.array(ratingItem);
