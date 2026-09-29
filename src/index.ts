import { handleBackfill, handleLakeBuild, handleSyncStatus } from "./admin";
import { buildLake, LAKE_CRON } from "./lake";
import { syncIncremental } from "./sync/incremental";
import { syncInstapaper } from "./instapaper/incremental";

export default {
  fetch(request, env): Response | Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/admin/sync") {
      return handleSyncStatus(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/backfill") {
      return handleBackfill(request, env);
    }
    if (request.method === "POST" && url.pathname === "/admin/lake") {
      return handleLakeBuild(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env): Promise<void> {
    if (controller.cron === LAKE_CRON) {
      // An unhandled error marks the scheduled invocation failed, so a build
      // that never wrote its tables gets noticed.
      await buildLake(env);
      return;
    }

    // One source at a time, since both draw on the invocation's six open
    // connections. Each logs its own sync failures, so a rejection here is a
    // misconfiguration, and one source's still leaves the other to run.
    const github = await settled(syncIncremental(env));
    const instapaper = await settled(syncInstapaper(env));
    for (const outcome of [github, instapaper]) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
    console.log(`sync trigger ${controller.cron} finished`);
  },
} satisfies ExportedHandler<Env>;

async function settled(run: Promise<void>): Promise<PromiseSettledResult<void>> {
  const [outcome] = await Promise.allSettled([run]);
  return outcome;
}
