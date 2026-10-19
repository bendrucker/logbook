#!/usr/bin/env bun
// Links the Worker to a Trakt account through Trakt's device flow. The Worker
// asks Trakt for a code, this prints it, and the account owner enters it at
// Trakt's verification URL while this polls the Worker, which exchanges the
// approved code and stores the grant. The client secret and the grant stay in
// the Worker.

import { z } from "zod";
import { adminToken, fail, parseUrl } from "./admin-client";

const USAGE = "usage: ADMIN_TOKEN=... bun run trakt:login <base-url>";

const DeviceCode = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_url: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

const PollResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("linked"), expiresAt: z.string() }),
  z.object({
    status: z.enum(["pending", "slow_down", "invalid", "used", "expired", "denied"]),
  }),
]);

const token = adminToken();
const [target] = Bun.argv.slice(2);
if (target === undefined) {
  fail(USAGE);
}
const base = parseUrl(target);

try {
  const code = DeviceCode.parse(await call("/admin/trakt/login"));
  console.log(
    `Open ${code.verification_url}/${code.user_code} and approve, or enter ${code.user_code}`,
  );

  const deadline = Date.now() + code.expires_in * 1000;
  let interval = code.interval * 1000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("the code expired before it was approved, rerun to get a new one");
    }
    // oxlint-disable-next-line no-await-in-loop -- Trakt asks for one poll per interval
    await Bun.sleep(interval);
    const url = `/admin/trakt/login/poll?device_code=${encodeURIComponent(code.device_code)}`;
    // oxlint-disable-next-line no-await-in-loop -- each poll waits on the one before
    const result = PollResult.parse(await call(url));
    if (result.status === "linked") {
      console.log(`Linked. The access token expires ${result.expiresAt} and refreshes itself.`);
      break;
    }
    if (result.status === "slow_down") {
      interval += 1000;
    } else if (result.status !== "pending") {
      throw new Error(`Trakt answered ${result.status}, rerun to start over`);
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function call(path: string): Promise<unknown> {
  const url = new URL(path, base);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${url.pathname} answered ${response.status}: ${body}`);
  }
  return JSON.parse(body);
}
