import { tracing } from "cloudflare:workers";
import { describe } from "./sync/run";

export interface Invocation {
  id: number;
  cron: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

// One `invocations` row around a scheduled invocation, written before `body`
// runs so an invocation that exceeds its limits and dies still shows as
// unfinished. The row is best effort: a write that fails is logged and never
// stops `body` or replaces its error. The span is local because the workerd the
// tests run on predates `getActiveSpan`.
export function recordInvocation(
  db: D1Database,
  cron: string,
  body: () => Promise<void>,
): Promise<void> {
  return tracing.enterSpan("logbook.invocation", async (span) => {
    const id = await startInvocation(db, cron);
    span.setAttributes({ "logbook.trigger": cron, "logbook.invocation_id": id ?? undefined });

    let failure: string | null = null;
    try {
      await body();
    } catch (error) {
      failure = describe(error);
      span.setAttributes({
        "error.type": error instanceof Error ? error.name : "unknown",
        "logbook.error": failure,
      });
      throw error;
    } finally {
      if (id !== null) {
        await finishInvocation(db, id, failure);
      }
    }
  });
}

async function startInvocation(db: D1Database, cron: string): Promise<number | null> {
  try {
    const { meta } = await db
      .prepare("INSERT INTO invocations (cron, started_at) VALUES (?1, ?2)")
      .bind(cron, new Date().toISOString())
      .run();
    return meta.last_row_id;
  } catch (error) {
    console.error({ event: "invocation.start_failed", cron, error: describe(error) });
    return null;
  }
}

async function finishInvocation(db: D1Database, id: number, failure: string | null): Promise<void> {
  try {
    await db
      .prepare("UPDATE invocations SET finished_at = ?2, error = ?3 WHERE id = ?1")
      .bind(id, new Date().toISOString(), failure)
      .run();
  } catch (error) {
    console.error({ event: "invocation.finish_failed", id, error: describe(error) });
  }
}

export async function recentInvocations(db: D1Database, limit: number): Promise<Invocation[]> {
  const { results } = await db
    .prepare(
      "SELECT id, cron, started_at, finished_at, error FROM invocations" +
        " ORDER BY started_at DESC, id DESC LIMIT ?",
    )
    .bind(limit)
    .all<{
      id: number;
      cron: string;
      started_at: string;
      finished_at: string | null;
      error: string | null;
    }>();
  return results.map((row) => ({
    id: row.id,
    cron: row.cron,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }));
}
