// The files of Apple's privacy export that Logbook reads, and the columns it
// keeps from each. Everything else, including the IP address, location, device
// IDs, and account fields on every play event, is dropped on the laptop before
// upload, and the Worker refuses a page carrying any column not listed here.

export const EXPORT_FILES = [
  "play-activity",
  "daily-tracks",
  "library-tracks",
  "favorites",
  "liked-radio-tracks",
] as const;

export type ExportFile = (typeof EXPORT_FILES)[number];

export const SOURCE_FILES: Record<ExportFile, string> = {
  "play-activity": "Apple Music Play Activity.csv",
  "daily-tracks": "Apple Music - Play History Daily Tracks.csv",
  "library-tracks": "Apple Music Library Tracks.json.zip",
  favorites: "Apple Music - Favorites.csv",
  "liked-radio-tracks": "Music - Liked Radio Tracks.csv",
};

export const COLUMNS = {
  "play-activity": [
    "Event ID",
    "Event Type",
    "Event Start Timestamp",
    "Event End Timestamp",
    "UTC Offset In Seconds",
    "Song Name",
    "Album Name",
    "Container Type",
    "Container Name",
    "Item Type",
    "Media Type",
    "Media Duration In Milliseconds",
    "Play Duration Milliseconds",
    "End Reason Type",
    "Feature Name",
    "Shuffle Play",
    "Offline",
  ],
  "daily-tracks": [
    "Date Played",
    "Hours",
    "Track Identifier",
    "Track Reference",
    "Track Description",
    "Media type",
    "Play Count",
    "Skip Count",
    "Play Duration Milliseconds",
    "End Reason Type",
    "Source Type",
  ],
  "library-tracks": [
    "Track Identifier",
    "Apple Music Track Identifier",
    "Title",
    "Artist",
    "Album",
    "Album Artist",
    "Genre",
    "Track Year",
    "Track Duration",
    "Date Added To Library",
    "Rating",
    "Track Like Rating",
    "Favorite Status - Track",
    "Is Purchased",
    "Track Play Count",
    "Skip Count",
  ],
  favorites: ["Favorite Type", "Item Reference", "Item Description", "Last Modified", "Preference"],
  "liked-radio-tracks": ["Created", "Track Description", "Event Type", "Item Reference Number"],
} as const satisfies Record<ExportFile, readonly string[]>;

export type ExportRecord = Record<string, unknown>;

// An empty CSV cell becomes null, so a page reads the same whether Apple wrote
// the column empty or the JSON export left the key out.
export function project(file: ExportFile, record: ExportRecord): ExportRecord {
  const kept: ExportRecord = {};
  for (const column of COLUMNS[file]) {
    const value = record[column];
    kept[column] = value === undefined || value === "" ? null : value;
  }
  return kept;
}

// Parses RFC 4180 CSV.
export function parseCsv(text: string): ExportRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (header === undefined) {
    return [];
  }
  return body
    .filter((cells) => cells.length > 1 || cells[0] !== "")
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
}
