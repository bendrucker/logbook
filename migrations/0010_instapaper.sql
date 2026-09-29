-- The user's own folders. Home, Archive, and Liked are built in and have no
-- row here.
CREATE TABLE instapaper_folders (
  folder_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  position INTEGER NOT NULL,
  public INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE instapaper_bookmarks (
  bookmark_id INTEGER PRIMARY KEY,
  -- Null for private content, such as a forwarded email, saved without one.
  url TEXT,
  title TEXT,
  -- What I wrote about the article when saving it, or its opening text.
  description TEXT,
  image TEXT,
  author TEXT,
  article_published_at TEXT,
  saved_at TEXT NOT NULL,
  liked INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  -- Null when the bookmark is in Home or the Archive.
  folder_id INTEGER,
  progress REAL NOT NULL,
  progress_at TEXT,
  private_source TEXT,
  -- 0 article, 1 email, 2 video, 3 PDF, 4 social, and more to come.
  category INTEGER NOT NULL,
  -- A JSON array of tag names.
  tags TEXT NOT NULL,
  -- When a change listing named the bookmark as deleted.
  deleted_at TEXT,
  fetched_at TEXT NOT NULL
);

-- No foreign key to bookmarks, since a highlight read can land before the
-- change listing that returns its bookmark.
CREATE TABLE instapaper_highlights (
  highlight_id INTEGER PRIMARY KEY,
  bookmark_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  note TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX instapaper_highlights_bookmark ON instapaper_highlights (bookmark_id);
