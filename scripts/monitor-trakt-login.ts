#!/usr/bin/env bun
// Links the monitor to a Trakt account through Trakt's device flow. The
// monitor has no admin surface, so the exchange happens here and the grant
// goes straight into the monitor's D1 through `wrangler d1 execute`. The
// monitor's Trakt application is a PKCE app with no client secret, so the
// client ID is all the exchange sends. The monitor refreshes it from then on.

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unstable_readConfig } from "wrangler";
import { z } from "zod";
import { fail } from "./admin-client";

const CONFIG = "workers/monitor/wrangler.jsonc";
const USER_AGENT = "logbook-monitor (+https://github.com/bendrucker/logbook)";

// The client ID the monitor sends, read from its config so the grant always
// belongs to the application the monitor refreshes it with.
const { vars } = z
  .object({ vars: z.object({ TRAKT_CLIENT_ID: z.string() }) })
  .parse(unstable_readConfig({ config: CONFIG }));
const clientId = vars.TRAKT_CLIENT_ID;

const DeviceCode = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_url: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

const Grant = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  created_at: z.number().int().positive(),
});

// Trakt answers each waiting state of a device login with its own status.
const WAITING: Partial<Record<number, string>> = {
  404: "invalid",
  409: "used",
  410: "expired",
  418: "denied",
};

try {
  const code = DeviceCode.parse(await post("/oauth/device/code", { client_id: clientId }));
  console.log(
    `Open ${code.verification_url}/${code.user_code} and approve, or enter ${code.user_code}`,
  );

  const deadline = Date.now() + code.expires_in * 1000;
  let interval = code.interval * 1000;
  let grant: z.infer<typeof Grant> | null = null;
  while (grant === null) {
    if (Date.now() > deadline) {
      throw new Error("the code expired before it was approved, rerun to get a new one");
    }
    // oxlint-disable-next-line no-await-in-loop -- Trakt asks for one poll per interval
    await Bun.sleep(interval);
    // oxlint-disable-next-line no-await-in-loop -- each poll waits on the one before
    const response = await fetch("https://api.trakt.tv/oauth/device/token", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ code: code.device_code, client_id: clientId }),
    });
    if (response.status === 429) {
      interval += 1000;
    } else if (response.status === 200) {
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here
      grant = Grant.parse(await response.json());
    } else if (response.status !== 400) {
      throw new Error(`Trakt answered ${WAITING[response.status] ?? response.status}, rerun`);
    }
  }

  await store(grant);
  const expiresAt = new Date((grant.created_at + grant.expires_in) * 1000).toISOString();
  console.log(`Linked. The access token expires ${expiresAt} and the monitor refreshes it.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function post(pathname: string, payload: Record<string, string>): Promise<unknown> {
  const response = await fetch(new URL(pathname, "https://api.trakt.tv"), {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`POST ${pathname} answered ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// Through a file rather than `--command`, so the tokens never sit in a process
// listing. The file lives under the gitignored `tmp/` only as long as the call.
async function store(grant: z.infer<typeof Grant>): Promise<void> {
  const expiresAt = new Date((grant.created_at + grant.expires_in) * 1000).toISOString();
  const values = [grant.access_token, grant.refresh_token, expiresAt, new Date().toISOString()]
    .map(quote)
    .join(", ");
  const sql = `INSERT INTO trakt_tokens (id, access_token, refresh_token, expires_at, updated_at) VALUES (1, ${values}) ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at;\n`;

  await mkdir("tmp", { recursive: true });
  const file = path.join("tmp", `monitor-trakt-grant-${process.pid}.sql`);
  await writeFile(file, sql, { mode: 0o600 });
  await chmod(file, 0o600);
  try {
    const child = Bun.spawn(
      [
        "bun",
        "run",
        "wrangler",
        "d1",
        "execute",
        "logbook-monitor",
        "--remote",
        "--config",
        CONFIG,
        "--file",
        file,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await child.exited) !== 0) {
      throw new Error("wrangler d1 execute failed, so the grant was not stored");
    }
  } finally {
    await rm(file, { force: true });
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
