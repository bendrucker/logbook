import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";
import { z } from "zod";

const configPath = "./wrangler.jsonc";

// Wrangler's declarations import its config type from a package it doesn't
// install, so the config arrives untyped.
const wranglerTriggers = z.object({ triggers: z.object({ crons: z.array(z.string()) }) });

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  // The scheduled handler dispatches on the cron expression, so a test needs
  // the ones the deployment actually triggers.
  const { triggers } = wranglerTriggers.parse(unstable_readConfig({ config: configPath }));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_CRONS: triggers.crons,
            // The pool reads `.dev.vars`, so without these a developer's real
            // credentials would reach the tests. Each test sets what it needs.
            GITHUB_TOKEN: "",
            TRAKT_CLIENT_ID: "",
            ADMIN_TOKEN: "",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts", "./test/reset-tables.ts"],
    },
  };
});
