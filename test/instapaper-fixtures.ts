// Instapaper API shapes as the Full API documents them. Nothing here has been
// checked against a live response yet.

export const SECRETS = {
  INSTAPAPER_CONSUMER_KEY: "consumer-key",
  INSTAPAPER_CONSUMER_SECRET: "consumer-secret",
  INSTAPAPER_ACCESS_TOKEN: "access-token",
  INSTAPAPER_ACCESS_SECRET: "access-secret",
} as const;

export function setSecrets(env: Env): void {
  Object.assign(env, SECRETS);
}

export function clearSecrets(env: Env): void {
  for (const name of Object.keys(SECRETS)) {
    Reflect.deleteProperty(env, name);
  }
}

export interface BookmarkFixture {
  type: "bookmark";
  bookmark_id: number;
  url: string;
  title: string;
  description: string;
  time: number;
  starred: "0" | "1";
  private_source: string;
  hash: string;
  progress: number;
  progress_timestamp: number;
  tags: { id: number; name: string }[];
}

// 2026-09-01T00:00:00Z plus the ID in seconds, so a bookmark's save time is
// predictable from its ID.
const SAVED_BASE = 1_788_220_800;

export function bookmark(id: number, overrides: Partial<BookmarkFixture> = {}): BookmarkFixture {
  return {
    type: "bookmark",
    bookmark_id: id,
    url: `https://example.com/${id}`,
    title: `Article ${id}`,
    description: "",
    time: SAVED_BASE + id,
    starred: "0",
    private_source: "",
    hash: `hash-${id}`,
    progress: 0,
    progress_timestamp: 0,
    tags: [],
    ...overrides,
  };
}

export interface HighlightFixture {
  type: "highlight";
  highlight_id: number;
  bookmark_id: number;
  text: string;
  note: string | null;
  position: number;
  time: number;
}

export function highlight(
  id: number,
  bookmarkId: number,
  overrides: Partial<HighlightFixture> = {},
): HighlightFixture {
  return {
    type: "highlight",
    highlight_id: id,
    bookmark_id: bookmarkId,
    text: `Passage ${id}`,
    note: null,
    position: 0,
    time: SAVED_BASE + 3600 + id,
    ...overrides,
  };
}

export function folder(id: number, title: string): Record<string, unknown> {
  return {
    type: "folder",
    folder_id: id,
    title,
    slug: title.toLowerCase(),
    display_title: title,
    sync_to_mobile: 1,
    position: id,
    public: 0,
  };
}

export const USER = { type: "user", user_id: 42, username: "ben@example.com" };

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

export function listing(
  bookmarks: readonly BookmarkFixture[],
  options: { highlights?: readonly HighlightFixture[]; deleteIds?: readonly number[] } = {},
): Response {
  return json({
    user: USER,
    bookmarks,
    highlights: options.highlights ?? [],
    delete_ids: options.deleteIds ?? [],
  });
}

export function apiError(code: number, message: string, init: ResponseInit = {}): Response {
  return json([{ type: "error", error_code: code, message }], { status: 400, ...init });
}

export interface InstapaperCall {
  path: string;
  form: Record<string, string>;
  authorization: string | null;
}

// Routes on the request rather than its order, since a sync reads its folders
// in an order the test would otherwise restate.
export function stubInstapaper(respond: (call: InstapaperCall) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: InstapaperCall[];
} {
  const calls: InstapaperCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const call = {
      path: new URL(request.url).pathname,
      form: Object.fromEntries(await formOf(request)),
      authorization: request.headers.get("Authorization"),
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

// Decoded by hand, since workerd warns on `text()` over a form body.
async function formOf(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
}

// The folder a `bookmarks/list` call asked for, or the method path otherwise.
export function route(call: InstapaperCall): string {
  return call.path === "/api/1/bookmarks/list" ? `list:${call.form.folder_id}` : call.path;
}
