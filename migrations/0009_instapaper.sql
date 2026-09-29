-- The user's own folders. Unread, Archive, and Starred are built in and have no
-- row here.
CREATE TABLE instapaper_folders (
  folder_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT,
  position REAL,
  public INTEGER,
  fetched_at TEXT NOT NULL
);

CREATE TABLE instapaper_bookmarks (
  bookmark_id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  -- What I wrote about the article when saving it, or the selection it was
  -- saved from. Null when empty.
  description TEXT,
  saved_at TEXT NOT NULL,
  -- Instapaper calls a starred bookmark liked.
  starred INTEGER NOT NULL,
  -- unread, archive, or folder, with folder_id naming which. Null for a
  -- bookmark only the starred listing has returned.
  folder TEXT,
  folder_id INTEGER,
  progress REAL NOT NULL,
  progress_at TEXT,
  -- The label of a private source such as email, whose url does not resolve.
  private_source TEXT,
  -- A JSON array of tag names.
  tags TEXT NOT NULL,
  -- Instapaper's hash of the url, title, description, and progress, which the
  -- incremental listing sends back so only changed bookmarks return.
  hash TEXT NOT NULL,
  -- When the bookmark dropped out of its folder's listing, which shows only
  -- the 500 most recent. It moved, it was deleted, or it aged out. Cleared when
  -- a listing of a folder returns it.
  unlisted_at TEXT,
  -- When Instapaper answered that the bookmark ID is invalid, which is what
  -- deleting it does.
  deleted_at TEXT,
  fetched_at TEXT NOT NULL
);

CREATE INDEX instapaper_bookmarks_folder ON instapaper_bookmarks (folder, folder_id)
  WHERE unlisted_at IS NULL;

CREATE INDEX instapaper_bookmarks_starred ON instapaper_bookmarks (saved_at) WHERE starred = 1;

-- No foreign key to bookmarks. The listing returns highlights beside the
-- bookmarks it returns, and one may belong to a bookmark it left out.
CREATE TABLE instapaper_highlights (
  highlight_id INTEGER PRIMARY KEY,
  bookmark_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  note TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX instapaper_highlights_bookmark ON instapaper_highlights (bookmark_id);
