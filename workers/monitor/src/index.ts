import { tracing } from "cloudflare:workers";
import { deliver, evaluateAlerts } from "./alerts";
import { collectContent, contentSources } from "./content";
import { collectLake, exportMetrics, recordMetrics } from "./metrics";
import { rules } from "./rules";

export default {
  async scheduled(_controller, env): Promise<void> {
    // Parsed first, so a malformed rule fails the run before anything is
    // measured rather than silently alerting on nothing.
    const parsed = rules.parse(env.ALERT_RULES);
    await tracing.enterSpan("monitor.run", async (span) => {
      const now = new Date();
      const metrics = [
        ...(await collectLake(env.LAKE, now)),
        ...(await collectContent(env.LAKE, await contentSources(env), now)),
      ];
      await recordMetrics(env.DB, now, metrics);
      exportMetrics(env.METRICS, metrics);
      const changes = await evaluateAlerts(env.DB, parsed, metrics, now);
      for (const change of changes) {
        deliver(change);
      }
      span.setAttributes({ "monitor.metrics": metrics.length, "monitor.changes": changes.length });
    });
    // The heartbeat says the monitor ran, whatever it found, so a monitor that
    // stops is noticed from outside Cloudflare.
    if (env.HEARTBEAT_URL !== undefined && env.HEARTBEAT_URL !== "") {
      await fetch(env.HEARTBEAT_URL);
    }
  },
} satisfies ExportedHandler<Env>;
