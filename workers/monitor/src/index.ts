import { tracing } from "cloudflare:workers";
import { probeLake, recordProbes } from "./probes";

export default {
  async scheduled(_controller, env): Promise<void> {
    await tracing.enterSpan("monitor.probe", async (span) => {
      const now = new Date();
      const probes = await probeLake(env.LAKE, now);
      await recordProbes(env.DB, now, probes);
      const bad = probes.filter((probe) => !probe.good);
      span.setAttributes({ "monitor.probes": probes.length, "monitor.bad": bad.length });
      console.log({
        event: "monitor.probed",
        probes: probes.length,
        bad: bad.map((probe) => probe.target),
      });
    });
    // The heartbeat says the monitor ran, whatever it found, so a monitor that
    // stops is noticed from outside Cloudflare.
    if (env.HEARTBEAT_URL !== undefined && env.HEARTBEAT_URL !== "") {
      await fetch(env.HEARTBEAT_URL);
    }
  },
} satisfies ExportedHandler<Env>;
