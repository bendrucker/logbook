// The crawl frontier: one row per window a backfill has to fetch, drained in
// window order until the budget stops it. Nothing here knows which source it
// crawls. The caller supplies how to fetch a window and how to split one that
// came back truncated.

export type UnitStatus = "pending" | "done" | "split" | "irreducible";

export interface UnitFetch {
  fetchedAt: string;
  pages: number;
  rowsChanged: number;
  cost: number;
  // A truncated response's rows still land, because truncation drops whole
  // items and never corrupts the ones returned.
  truncated: boolean;
  error: string | null;
  // Set when the rate budget or a secondary limit stopped the fetch: the
  // instant worth waiting for. The limit belongs to the token, so the drain
  // stops rather than trying the next window.
  resumeAt: string | null;
}

export interface CrawlSource {
  // Every page in R2 and every row in D1 before it resolves, which is what lets
  // the unit be marked done.
  fetch(window: string): Promise<UnitFetch>;
  // The narrower windows a truncated one is fetched again as. None means the
  // window cannot narrow further and stays irreducible.
  split(window: string): readonly string[];
}

export interface Drain {
  windows: string[];
  pages: number;
  rowsChanged: number;
  resumeAt: string | null;
  error: string | null;
}

// A window already in the frontier keeps its status, so enqueueing the same
// roots again resumes the crawl instead of refetching what finished.
export async function enqueue(
  db: D1Database,
  kind: string,
  windows: readonly string[],
  at: string = new Date().toISOString(),
): Promise<void> {
  if (windows.length === 0) {
    return;
  }
  const insert = insertUnit(db);
  await db.batch(windows.map((window) => insert.bind(kind, window, null, "pending", at)));
}

// A window outside the frontier still truncated at its finest split, recorded
// so the sync status reports it the way it reports one the crawl reached. A
// window already in the frontier keeps the status its own crawl gives it.
export async function recordIrreducible(
  db: D1Database,
  kind: string,
  windows: readonly string[],
  at: string,
): Promise<void> {
  if (windows.length === 0) {
    return;
  }
  const insert = insertUnit(db);
  await db.batch(windows.map((window) => insert.bind(kind, window, null, "irreducible", at)));
}

function insertUnit(db: D1Database): D1PreparedStatement {
  return db.prepare(
    "INSERT OR IGNORE INTO crawl_units (kind, window, parent, status, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  );
}

// Units drain in window order. A split's children sort right after their
// parent and before its next sibling, so the crawl finishes one window's
// subtree before it moves on.
export async function drain(db: D1Database, kind: string, source: CrawlSource): Promise<Drain> {
  const result: Drain = { windows: [], pages: 0, rowsChanged: 0, resumeAt: null, error: null };

  let window = await nextPending(db, kind);
  while (window !== null) {
    // Each unit's pages are read one after another under a budget that has to
    // see one response before it admits the next request.
    // oxlint-disable-next-line no-await-in-loop -- the drain stops at the first unit that fails
    const fetched = await source.fetch(window);
    result.windows.push(window);
    result.pages += fetched.pages;
    result.rowsChanged += fetched.rowsChanged;

    // An interrupted unit stays pending and restarts from its first page. A
    // unit is at most ten pages, so a cursor isn't worth persisting.
    if (fetched.error !== null) {
      return { ...result, resumeAt: fetched.resumeAt, error: fetched.error };
    }

    // oxlint-disable-next-line no-await-in-loop -- a unit settles before the next is picked, or it would be picked again
    await settle(db, kind, window, fetched, fetched.truncated ? source.split(window) : null);
    // oxlint-disable-next-line no-await-in-loop -- settling a truncated unit enqueues the windows it splits into
    window = await nextPending(db, kind);
  }

  return result;
}

async function nextPending(db: D1Database, kind: string): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT window FROM crawl_units WHERE kind = ?1 AND status = 'pending' ORDER BY window LIMIT 1",
    )
    .bind(kind)
    .first<{ window: string }>();
  return row?.window ?? null;
}

// The unit's status and its children land in one batch, so a failure between
// them cannot leave a split parent with nothing under it.
async function settle(
  db: D1Database,
  kind: string,
  window: string,
  fetched: UnitFetch,
  children: readonly string[] | null,
): Promise<void> {
  const status = unitStatus(children);
  const at = new Date().toISOString();
  const insert = insertUnit(db);

  await db.batch([
    db
      .prepare(
        "UPDATE crawl_units SET status = ?3, fetched_at = ?4, pages = ?5, cost = ?6, updated_at = ?7" +
          " WHERE kind = ?1 AND window = ?2",
      )
      .bind(kind, window, status, fetched.fetchedAt, fetched.pages, fetched.cost, at),
    ...(children ?? []).map((child) => insert.bind(kind, child, window, "pending", at)),
  ]);
}

function unitStatus(children: readonly string[] | null): UnitStatus {
  if (children === null) {
    return "done";
  }
  return children.length === 0 ? "irreducible" : "split";
}

export interface FrontierStatus {
  pending: number;
  // Windows still truncated at the finest split, which no further crawl
  // recovers.
  irreducible: string[];
}

// A kind with no units reads as absent.
export async function frontierStatus(db: D1Database): Promise<Map<string, FrontierStatus>> {
  const [pending, irreducible] = await Promise.all([
    db
      .prepare(
        "SELECT kind, COUNT(*) AS total FROM crawl_units WHERE status = 'pending' GROUP BY kind",
      )
      .all<{ kind: string; total: number }>(),
    db
      .prepare(
        "SELECT kind, window FROM crawl_units WHERE status = 'irreducible' ORDER BY kind, window",
      )
      .all<{ kind: string; window: string }>(),
  ]);

  const status = new Map<string, FrontierStatus>();
  const of = (kind: string): FrontierStatus => {
    const existing = status.get(kind) ?? { pending: 0, irreducible: [] };
    status.set(kind, existing);
    return existing;
  };
  for (const row of pending.results) {
    of(row.kind).pending = row.total;
  }
  for (const row of irreducible.results) {
    of(row.kind).irreducible.push(row.window);
  }
  return status;
}
