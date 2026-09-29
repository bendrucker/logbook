-- Trakt numbers movies, shows, seasons, and episodes in separate ID spaces, so
-- a title is keyed on its type and its Trakt ID together.
CREATE TABLE trakt_titles (
  -- movie, show, season, episode.
  type TEXT NOT NULL,
  trakt_id INTEGER NOT NULL,
  slug TEXT,
  -- Null for a season or an episode Trakt has no title for.
  title TEXT,
  year INTEGER,
  show_trakt_id INTEGER,
  season INTEGER,
  number INTEGER,
  imdb_id TEXT,
  tmdb_id INTEGER,
  tvdb_id INTEGER,
  -- A movie's release date, YYYY-MM-DD.
  released TEXT,
  first_aired TEXT,
  runtime INTEGER,
  -- A JSON array of genre slugs.
  genres TEXT,
  certification TEXT,
  network TEXT,
  country TEXT,
  language TEXT,
  status TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (type, trakt_id)
);

CREATE TABLE trakt_plays (
  id INTEGER PRIMARY KEY,
  watched_at TEXT NOT NULL,
  -- scrobble, checkin, watch.
  action TEXT NOT NULL,
  -- movie or episode.
  type TEXT NOT NULL,
  trakt_id INTEGER NOT NULL,
  show_trakt_id INTEGER,
  FOREIGN KEY (type, trakt_id) REFERENCES trakt_titles (type, trakt_id)
);

CREATE INDEX trakt_plays_watched_at ON trakt_plays (watched_at);

-- Trakt holds one rating per title and gives it no ID of its own.
CREATE TABLE trakt_ratings (
  type TEXT NOT NULL,
  trakt_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  rated_at TEXT NOT NULL,
  show_trakt_id INTEGER,
  PRIMARY KEY (type, trakt_id),
  FOREIGN KEY (type, trakt_id) REFERENCES trakt_titles (type, trakt_id)
);
