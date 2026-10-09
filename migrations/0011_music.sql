-- One listen, from any music source. Each `*_key` column is its name trimmed
-- and lowercased, which is what tracks match on across sources that don't
-- share an ID.
CREATE TABLE music_plays (
  -- apple-export.
  source TEXT NOT NULL,
  -- The source's own ID for the play: Apple's event ID.
  id TEXT NOT NULL,
  played_at TEXT NOT NULL,
  -- The listener's offset from UTC when the play started.
  utc_offset_seconds INTEGER,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  -- Null when the source leaves it out and nothing resolved it. Apple's
  -- per-play events never carry one.
  artist TEXT,
  artist_key TEXT NOT NULL DEFAULT '',
  -- How the artist was found when the source left it out: same-day, library,
  -- or title.
  artist_match TEXT,
  album TEXT,
  album_key TEXT NOT NULL,
  duration_ms INTEGER,
  -- Capped at `duration_ms`, since Apple reports plays hundreds of hours long.
  played_ms INTEGER,
  end_reason TEXT,
  container_type TEXT,
  container_name TEXT,
  PRIMARY KEY (source, id)
);

CREATE INDEX music_plays_played_at ON music_plays (played_at);
CREATE INDEX music_plays_track ON music_plays (artist_key, title_key);

-- What the site reviews: one row per track across every source's plays. The
-- site holds the approve and publish decisions.
CREATE TABLE music_tracks (
  -- Empty when no play of the track resolved an artist.
  artist_key TEXT NOT NULL,
  title_key TEXT NOT NULL,
  artist TEXT,
  title TEXT NOT NULL,
  -- From the most recent play.
  album TEXT,
  album_key TEXT NOT NULL,
  plays INTEGER NOT NULL,
  first_played_at TEXT NOT NULL,
  last_played_at TEXT NOT NULL,
  loved INTEGER NOT NULL,
  -- 1 to 5 from the library's star rating, null when unrated.
  stars INTEGER,
  -- A dislike or radio ban of the track, its album, or its artist.
  disliked INTEGER NOT NULL,
  PRIMARY KEY (artist_key, title_key)
);

-- Apple's per-day rollup. Its `Artist - Song` description is what names the
-- artist on a play the per-play events leave anonymous.
CREATE TABLE apple_music_daily_tracks (
  -- A hash of the whole record. No combination of the rollup's columns is
  -- unique, so a row is its content: importing the same export again writes
  -- nothing, and a day a newer export revised lands beside the older row.
  id TEXT PRIMARY KEY,
  played_on TEXT NOT NULL,
  track_id TEXT NOT NULL,
  -- IPHONE, MACINTOSH, HOMEPOD, IPAD, or empty.
  device TEXT NOT NULL,
  -- As Apple lists them, or empty.
  hours TEXT NOT NULL,
  track_reference TEXT,
  description TEXT,
  artist TEXT,
  artist_key TEXT NOT NULL,
  title TEXT,
  title_key TEXT NOT NULL,
  play_count INTEGER,
  skip_count INTEGER,
  played_ms INTEGER,
  end_reason TEXT
);

CREATE INDEX apple_music_daily_tracks_title ON apple_music_daily_tracks (title_key, played_on);

CREATE TABLE apple_music_library_tracks (
  track_id INTEGER PRIMARY KEY,
  catalog_id INTEGER,
  title TEXT,
  title_key TEXT NOT NULL,
  artist TEXT,
  artist_key TEXT NOT NULL,
  album TEXT,
  album_key TEXT NOT NULL,
  album_artist TEXT,
  genre TEXT,
  year INTEGER,
  duration_ms INTEGER,
  added_at TEXT,
  -- 0 to 100 in steps of 20, as Apple stores stars.
  rating INTEGER,
  loved INTEGER NOT NULL,
  purchased INTEGER,
  play_count INTEGER,
  skip_count INTEGER
);

CREATE INDEX apple_music_library_tracks_title ON apple_music_library_tracks (title_key, album_key);

CREATE TABLE apple_music_preferences (
  -- favorites or radio.
  source TEXT NOT NULL,
  -- song, album, artist, or playlist.
  type TEXT NOT NULL,
  reference TEXT NOT NULL,
  description TEXT,
  artist_key TEXT NOT NULL,
  -- The song or album name. Empty for an artist or a playlist.
  title_key TEXT NOT NULL,
  -- like or dislike.
  preference TEXT NOT NULL,
  changed_at TEXT,
  PRIMARY KEY (source, type, reference)
);
