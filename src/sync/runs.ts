import { byKind, SYNC_KINDS, type SyncKind } from "./kinds";

export interface SyncRun {
  id: number;
  // A write takes a SyncKind, but the column has no CHECK constraint, so a run
  // written before a kind was renamed still reads back under its old name.
  kind: string;
  window: string;
  startedAt: string;
  finishedAt: string | null;
  pages: number;
  rowsChanged: number;
  truncated: boolean;
  error: string | null;
  note: string | null;
  cost: number;
  rateRemaining: number | null;
}

export interface RunResult {
  pages: number;
  rowsChanged: number;
  truncated: boolean;
  error: string | null;
  // Something worth reading that did not stop the run, which today means the
  // contributions cross-check disagreeing with the event tables.
  note: string | null;
  // Points the run's requests spent, which the rate budget sums into its ledger.
  cost: number;
  // The last `remaining` GitHub reported to the run, null for a run that sent
  // nothing.
  rateRemaining: number | null;
}

interface RunRow {
  id: number;
  kind: string;
  window: string;
  started_at: string;
  finished_at: string | null;
  pages: number;
  rows_changed: number;
  truncated: number;
  error: string | null;
  note: string | null;
  cost: number;
  rate_remaining: number | null;
}

const selection =
  "SELECT id, kind, window, started_at, finished_at, pages, rows_changed, truncated, error, note, cost, rate_remaining FROM sync_runs";

export async function startRun(
  db: D1Database,
  kind: SyncKind,
  window: string,
  at: string = new Date().toISOString(),
): Promise<number> {
  const { meta } = await db
    .prepare("INSERT INTO sync_runs (kind, window, started_at) VALUES (?1, ?2, ?3)")
    .bind(kind, window, at)
    .run();
  return meta.last_row_id;
}

// Counts and an error travel together so a run that failed on page four still
// reports the three pages it did land.
export async function finishRun(
  db: D1Database,
  id: number,
  result: RunResult,
  at: string = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      "UPDATE sync_runs SET finished_at = ?2, pages = ?3, rows_changed = ?4, truncated = ?5, error = ?6, note = ?7," +
        " cost = ?8, rate_remaining = ?9" +
        " WHERE id = ?1",
    )
    .bind(
      id,
      at,
      result.pages,
      result.rowsChanged,
      result.truncated ? 1 : 0,
      result.error,
      result.note,
      result.cost,
      result.rateRemaining,
    )
    .run();
}

export interface RunSpend {
  startedAt: string;
  cost: number;
}

// Every kind spends from one token's budget, so the spend reads across kinds.
export async function spendSince(db: D1Database, since: string): Promise<RunSpend[]> {
  const { results } = await db
    .prepare("SELECT started_at, cost FROM sync_runs WHERE started_at >= ?1 AND cost > 0")
    .bind(since)
    .all<{ started_at: string; cost: number }>();
  return results.map((row) => ({ startedAt: row.started_at, cost: row.cost }));
}

export async function lastRuns(db: D1Database): Promise<Record<SyncKind, SyncRun | null>> {
  const statement = db.prepare(
    `${selection} WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  const results = await db.batch<RunRow>(SYNC_KINDS.map((kind) => statement.bind(kind)));

  // batch answers in the order it was given, so each kind reads its own result.
  return byKind((kind) => {
    const row = results[SYNC_KINDS.indexOf(kind)]?.results[0];
    return row === undefined ? null : toRun(row);
  });
}

export async function recentRuns(
  db: D1Database,
  kind: SyncKind,
  limit: number,
): Promise<SyncRun[]> {
  const { results } = await db
    .prepare(`${selection} WHERE kind = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2`)
    .bind(kind, limit)
    .all<RunRow>();
  return results.map(toRun);
}

export async function recentFailures(db: D1Database, limit: number): Promise<SyncRun[]> {
  const { results } = await db
    .prepare(`${selection} WHERE error IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all<RunRow>();
  return results.map(toRun);
}

function toRun(row: RunRow): SyncRun {
  return {
    id: row.id,
    kind: row.kind,
    window: row.window,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    pages: row.pages,
    rowsChanged: row.rows_changed,
    truncated: row.truncated !== 0,
    error: row.error,
    note: row.note,
    cost: row.cost,
    rateRemaining: row.rate_remaining,
  };
}
