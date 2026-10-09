import { z } from "zod";
import { COLUMNS } from "./export";

const cell = z.string().nullable();

// Strict, and each shape written out against its allowlist, so a page that
// kept a column the projection drops, like the IP address on a play event,
// fails here rather than landing in R2.

export const playActivityRecord = z.strictObject({
  "Event ID": z.string(),
  "Event Type": cell,
  "Event Start Timestamp": cell,
  "Event End Timestamp": cell,
  "UTC Offset In Seconds": cell,
  "Song Name": cell,
  "Album Name": cell,
  "Container Type": cell,
  "Container Name": cell,
  "Item Type": cell,
  "Media Type": cell,
  "Media Duration In Milliseconds": cell,
  "Play Duration Milliseconds": cell,
  "End Reason Type": cell,
  "Feature Name": cell,
  "Shuffle Play": cell,
  Offline: cell,
} satisfies Record<(typeof COLUMNS)["play-activity"][number], z.ZodType>);

export const dailyTrackRecord = z.strictObject({
  "Date Played": z.string().regex(/^\d{8}$/),
  Hours: cell,
  "Track Identifier": z.string(),
  "Track Reference": cell,
  "Track Description": cell,
  "Media type": cell,
  "Play Count": cell,
  "Skip Count": cell,
  "Play Duration Milliseconds": cell,
  "End Reason Type": cell,
  "Source Type": cell,
} satisfies Record<(typeof COLUMNS)["daily-tracks"][number], z.ZodType>);

const count = z.number().int().nonnegative().nullable();

export const libraryTrackRecord = z.strictObject({
  "Track Identifier": z.number().int(),
  "Apple Music Track Identifier": count,
  Title: cell,
  Artist: cell,
  Album: cell,
  "Album Artist": cell,
  Genre: cell,
  "Track Year": count,
  "Track Duration": count,
  "Date Added To Library": cell,
  Rating: count,
  "Track Like Rating": cell,
  "Favorite Status - Track": z.boolean().nullable(),
  "Is Purchased": z.boolean().nullable(),
  "Track Play Count": count,
  "Skip Count": count,
} satisfies Record<(typeof COLUMNS)["library-tracks"][number], z.ZodType>);

export const favoriteRecord = z.strictObject({
  "Favorite Type": z.string(),
  "Item Reference": z.string(),
  "Item Description": cell,
  "Last Modified": cell,
  Preference: z.enum(["LIKE", "DISLIKE"]),
} satisfies Record<(typeof COLUMNS)["favorites"][number], z.ZodType>);

export const likedRadioTrackRecord = z.strictObject({
  Created: cell,
  "Track Description": cell,
  "Event Type": z.string(),
  "Item Reference Number": z.string(),
} satisfies Record<(typeof COLUMNS)["liked-radio-tracks"][number], z.ZodType>);

export type PlayActivityRecord = z.infer<typeof playActivityRecord>;
export type DailyTrackRecord = z.infer<typeof dailyTrackRecord>;
export type LibraryTrackRecord = z.infer<typeof libraryTrackRecord>;
export type FavoriteRecord = z.infer<typeof favoriteRecord>;
export type LikedRadioTrackRecord = z.infer<typeof likedRadioTrackRecord>;
