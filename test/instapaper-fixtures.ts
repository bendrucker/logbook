// Instapaper API v2 shapes as its OpenAPI spec and SDK types describe them.
// Nothing here has been checked against a live response yet.

export const TOKEN = "access-token";

export function setSecrets(env: Env): void {
  env.INSTAPAPER_ACCESS_TOKEN = TOKEN;
}

export function clearSecrets(env: Env): void {
  Reflect.deleteProperty(env, "INSTAPAPER_ACCESS_TOKEN");
}

export interface BookmarkFixture {
  id: number;
  url: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  progress: { percentage: number; timestamp: number };
  liked: boolean;
  archived: boolean;
  time: number;
  pubtime: number | null;
  author: string | null;
  folder_id: number | null;
  tags: { id: number; name: string; slug: string; count: number; baton: null }[];
  private_source: string | null;
  category: number;
}

// 2026-09-01T00:00:00Z plus the ID in seconds, so a bookmark's save time is
// predictable from its ID.
const SAVED_BASE = 1_788_220_800;

export function bookmark(id: number, overrides: Partial<BookmarkFixture> = {}): BookmarkFixture {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Article ${id}`,
    description: null,
    image: null,
    progress: { percentage: 0, timestamp: 0 },
    liked: false,
    archived: false,
    time: SAVED_BASE + id,
    pubtime: null,
    author: null,
    folder_id: null,
    tags: [],
    private_source: null,
    category: 0,
    ...overrides,
  };
}

export interface HighlightFixture {
  id: number;
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
    id,
    bookmark_id: bookmarkId,
    text: `Passage ${id}`,
    note: null,
    position: 0,
    time: SAVED_BASE + 3600 + id,
    ...overrides,
  };
}

export function folder(id: number, title: string): Record<string, unknown> {
  return { id, title, slug: title.toLowerCase(), position: id, public: false, count: 0 };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

export function changes(
  bookmarks: readonly BookmarkFixture[],
  deletedIds: readonly number[] = [],
): Response {
  return json({ bookmarks, total: bookmarks.length + deletedIds.length, deleted_ids: deletedIds });
}

export function folders(...list: Record<string, unknown>[]): Response {
  return json({ folders: list });
}

export function highlights(...list: HighlightFixture[]): Response {
  return json({ highlights: list });
}

export function apiError(status: number, message: string, init: ResponseInit = {}): Response {
  return json({ error: { code: status, message } }, { status, ...init });
}

export interface InstapaperCall {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
}

// Routes on the request rather than its order, since a sync reads in an order
// the test would otherwise restate.
export function stubInstapaper(respond: (call: InstapaperCall) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: InstapaperCall[];
} {
  const calls: InstapaperCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const call = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get("Authorization"),
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

// A highlights path names its bookmark, so a test routes on `highlights:<id>`.
export function route(call: InstapaperCall): string {
  const match = /^\/api\/2\/bookmarks\/(\d+)\/highlights$/.exec(call.path);
  return match === null ? call.path : `highlights:${match[1]}`;
}
