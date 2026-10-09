import { APPLE_SOURCE } from "./rows";

// Apple's play events name the song and album but never the artist. Each play
// takes the one artist the first of these agrees on:
//
// - same-day: the daily rollup's `Artist - Song` for the same title within a
//   day of the play, which allows for the rollup's day being local or UTC
// - library: the library track with the same title and album
// - title: the daily rollup's only artist for the title on any day
//
// A rung that names two artists is skipped rather than guessed between.
const RESOLVE_ARTISTS = `
WITH apple AS (
  SELECT id, title_key, album_key,
    date(played_at, coalesce(utc_offset_seconds, 0) || ' seconds') AS local_day
  FROM music_plays
  WHERE source = ?1
),
same_day AS (
  SELECT apple.id, MIN(daily.artist) AS artist, MIN(daily.artist_key) AS artist_key
  FROM apple
  JOIN apple_music_daily_tracks AS daily
    ON daily.title_key = apple.title_key
    AND daily.played_on BETWEEN date(apple.local_day, '-1 day') AND date(apple.local_day, '+1 day')
  WHERE daily.artist_key <> ''
  GROUP BY apple.id
  HAVING COUNT(DISTINCT daily.artist_key) = 1
),
library AS (
  SELECT apple.id, MIN(library.artist) AS artist, MIN(library.artist_key) AS artist_key
  FROM apple
  JOIN apple_music_library_tracks AS library
    ON library.title_key = apple.title_key AND library.album_key = apple.album_key
  WHERE library.artist_key <> ''
  GROUP BY apple.id
  HAVING COUNT(DISTINCT library.artist_key) = 1
),
by_title AS (
  SELECT apple.id, MIN(daily.artist) AS artist, MIN(daily.artist_key) AS artist_key
  FROM apple
  JOIN apple_music_daily_tracks AS daily ON daily.title_key = apple.title_key
  WHERE daily.artist_key <> ''
  GROUP BY apple.id
  HAVING COUNT(DISTINCT daily.artist_key) = 1
),
resolved AS (
  SELECT apple.id,
    coalesce(same_day.artist, library.artist, by_title.artist) AS artist,
    coalesce(same_day.artist_key, library.artist_key, by_title.artist_key, '') AS artist_key,
    CASE
      WHEN same_day.id IS NOT NULL THEN 'same-day'
      WHEN library.id IS NOT NULL THEN 'library'
      WHEN by_title.id IS NOT NULL THEN 'title'
    END AS artist_match
  FROM apple
  LEFT JOIN same_day ON same_day.id = apple.id
  LEFT JOIN library ON library.id = apple.id
  LEFT JOIN by_title ON by_title.id = apple.id
)
UPDATE music_plays
SET artist = resolved.artist, artist_key = resolved.artist_key, artist_match = resolved.artist_match
FROM resolved
WHERE music_plays.source = ?1
  AND music_plays.id = resolved.id
  AND (
    music_plays.artist IS NOT resolved.artist
    OR music_plays.artist_key IS NOT resolved.artist_key
    OR music_plays.artist_match IS NOT resolved.artist_match
  )`;

const TRACK_COLUMNS = [
  "artist",
  "title",
  "album",
  "album_key",
  "plays",
  "first_played_at",
  "last_played_at",
  "loved",
  "stars",
  "disliked",
] as const;

// A track whose plays resolved no artist matches no signal, since every signal
// names one.
//
// A dislike reaches past the song to its album and its artist, unlike a love,
// because a dislike only seeds a rejection the site can reverse.
const UPSERT_TRACKS = `
WITH ranked AS (
  SELECT artist_key, title_key, artist, title, album, album_key,
    ROW_NUMBER() OVER (
      PARTITION BY artist_key, title_key ORDER BY played_at DESC, source, id
    ) AS recency
  FROM music_plays
),
counted AS (
  SELECT artist_key, title_key, COUNT(*) AS plays,
    MIN(played_at) AS first_played_at, MAX(played_at) AS last_played_at
  FROM music_plays
  GROUP BY artist_key, title_key
)
INSERT INTO music_tracks (artist_key, title_key, ${TRACK_COLUMNS.join(", ")})
SELECT
  counted.artist_key,
  counted.title_key,
  ranked.artist,
  ranked.title,
  ranked.album,
  ranked.album_key,
  counted.plays,
  counted.first_played_at,
  counted.last_played_at,
  counted.artist_key <> '' AND (
    EXISTS (
      SELECT 1 FROM apple_music_library_tracks AS library
      WHERE library.artist_key = counted.artist_key
        AND library.title_key = counted.title_key
        AND library.loved = 1
    )
    OR EXISTS (
      SELECT 1 FROM apple_music_preferences AS preference
      WHERE preference.type = 'song'
        AND preference.preference = 'like'
        AND preference.artist_key = counted.artist_key
        AND preference.title_key = counted.title_key
    )
  ),
  (
    SELECT MAX(library.rating) / 20 FROM apple_music_library_tracks AS library
    WHERE counted.artist_key <> ''
      AND library.artist_key = counted.artist_key
      AND library.title_key = counted.title_key
      AND library.rating > 0
  ),
  counted.artist_key <> '' AND EXISTS (
    SELECT 1 FROM apple_music_preferences AS preference
    WHERE preference.preference = 'dislike'
      AND preference.artist_key = counted.artist_key
      AND (
        preference.type = 'artist'
        OR (preference.type = 'song' AND preference.title_key = counted.title_key)
        OR (
          preference.type = 'album'
          AND preference.title_key IN (
            SELECT album_key FROM music_plays AS play
            WHERE play.artist_key = counted.artist_key AND play.title_key = counted.title_key
          )
        )
      )
  )
FROM counted
JOIN ranked
  ON ranked.artist_key = counted.artist_key
  AND ranked.title_key = counted.title_key
  AND ranked.recency = 1
WHERE true
ON CONFLICT (artist_key, title_key) DO UPDATE SET
  ${TRACK_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}
WHERE ${TRACK_COLUMNS.map((column) => `music_tracks.${column} IS NOT excluded.${column}`).join(" OR ")}`;

// A track whose plays all resolved to another artist since the last refresh.
const DELETE_ORPHANED_TRACKS = `
DELETE FROM music_tracks
WHERE NOT EXISTS (
  SELECT 1 FROM music_plays AS play
  WHERE play.artist_key = music_tracks.artist_key AND play.title_key = music_tracks.title_key
)`;

export interface TracksRefresh {
  // Apple plays whose artist changed.
  artistsChanged: number;
  tracksChanged: number;
  plays: number;
  // Apple plays no rung named an artist for.
  unresolved: number;
  tracks: number;
}

// Runs after an import's last page, since the artist a play resolves to
// depends on the daily rollup and the library, which may land after it. The
// library and preferences are snapshots, so rows older than `exportId` are
// ones the export dropped.
export async function refreshTracks(db: D1Database, exportId: string): Promise<TracksRefresh> {
  const results = await db.batch([
    db.prepare("DELETE FROM apple_music_library_tracks WHERE export_id < ?1").bind(exportId),
    db.prepare("DELETE FROM apple_music_preferences WHERE export_id < ?1").bind(exportId),
    db.prepare(RESOLVE_ARTISTS).bind(APPLE_SOURCE),
    db.prepare(UPSERT_TRACKS),
    db.prepare(DELETE_ORPHANED_TRACKS),
  ]);
  const [resolved, upserted, deleted] = results.slice(2);
  const counts = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM music_plays) AS plays,
        (SELECT COUNT(*) FROM music_plays WHERE source = ?1 AND artist_match IS NULL) AS unresolved,
        (SELECT COUNT(*) FROM music_tracks) AS tracks`,
    )
    .bind(APPLE_SOURCE)
    .first<{ plays: number; unresolved: number; tracks: number }>();

  return {
    artistsChanged: resolved?.meta.changes ?? 0,
    tracksChanged: (upserted?.meta.changes ?? 0) + (deleted?.meta.changes ?? 0),
    plays: counts?.plays ?? 0,
    unresolved: counts?.unresolved ?? 0,
    tracks: counts?.tracks ?? 0,
  };
}
