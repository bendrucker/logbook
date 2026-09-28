#!/usr/bin/env bun
// Drives POST /admin/backfill to completion. One call enqueues the kind's
// windows from `--from` to the present and drains the frontier until its rate
// cap, answering with how many windows are still pending. The walk over a
// decade of history is a loop out here rather than one long request in there.
// A call the rate budget or a secondary limit stopped names when to resume,
// and the loop sleeps until then.

import { parseArgs } from "node:util";
import { z } from "zod";
import { SYNC_KINDS, type SyncKind } from "../src/sync/kinds";

const USAGE = `usage: ADMIN_TOKEN=... bun run backfill <base-url> [${SYNC_KINDS.join("|")}] [--from YYYY-MM]`;

const KIND_WIDTH = Math.max(...SYNC_KINDS.map((kind) => kind.length));

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The route answers 200 with an `error` for a window that failed mid-walk, so
// the shape is the same either way and the fields decide whether to continue.
const BackfillResult = z.object({
  kind: z.string(),
  windows: z.array(z.string()),
  pages: z.number(),
  rowsChanged: z.number(),
  pending: z.number(),
  irreducible: z.array(z.string()),
  resumeAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});

type BackfillResult = z.infer<typeof BackfillResult>;

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string" },
  },
  allowPositionals: true,
});

const token = adminToken();
const [target, requested] = positionals;
if (target === undefined) {
  fail(USAGE);
}
if (requested !== undefined && !isSyncKind(requested)) {
  fail(USAGE);
}
const base = parseUrl(target);
const kinds = requested === undefined ? SYNC_KINDS : [requested];

try {
  for (const each of kinds) {
    // Kinds share one GitHub rate limit and one Worker, and a kind that stops
    // on a failed window should stop the run before the next kind spends
    // requests reaching the same wall.
    // eslint-disable-next-line no-await-in-loop
    await walk(each);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function walk(kind: SyncKind): Promise<void> {
  for (;;) {
    // Every call passes the same `--from`. The frontier keeps what finished, so
    // enqueueing the same windows again carries on rather than refetching.
    // eslint-disable-next-line no-await-in-loop
    const result = await backfill(kind, flags.from);
    console.log(describe(result));

    const wait = result.resumeAt === null ? null : Date.parse(result.resumeAt) - Date.now();
    if (result.error !== null && result.resumeAt === null) {
      throw new Error(`${kind} stopped on a failed window, rerun to retry it`);
    }
    if (result.pending === 0) {
      return;
    }
    // Windows left pending with nothing landed and nothing to wait for would
    // spin here forever. A cap of 0 produces it.
    if (result.pages === 0 && (wait === null || wait <= 0)) {
      throw new Error(`${kind} did not advance with ${result.pending} windows pending`);
    }
    if (wait !== null && wait > 0) {
      console.log(`${kind.padEnd(KIND_WIDTH)} waiting until ${result.resumeAt}`);
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(wait);
    }
  }
}

async function backfill(kind: SyncKind, from: string | undefined): Promise<BackfillResult> {
  const url = new URL("/admin/backfill", base);
  url.searchParams.set("kind", kind);
  if (from !== undefined) {
    url.searchParams.set("from", from);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${url.pathname}${url.search} answered ${response.status}: ${body}`);
  }

  return BackfillResult.parse(JSON.parse(body));
}

function describe(result: BackfillResult): string {
  const range =
    result.windows.length === 0 ? "no windows" : `${result.windows[0]}..${result.windows.at(-1)}`;
  const resume = result.pending === 0 ? "done" : `pending ${result.pending}`;
  const line = [
    result.kind.padEnd(KIND_WIDTH),
    range.padEnd(17),
    `pages ${result.pages}`.padEnd(11),
    `rows ${result.rowsChanged}`.padEnd(12),
    resume,
  ].join(" ");
  const irreducible =
    result.irreducible.length === 0 ? "" : `  irreducible ${result.irreducible.join(", ")}`;
  return result.error === null ? `${line}${irreducible}` : `${line}${irreducible}  ${result.error}`;
}

function adminToken(): string {
  const value = Bun.env["ADMIN_TOKEN"];
  if (value === undefined || value === "") {
    fail("ADMIN_TOKEN is unset");
  }
  return value;
}

function isSyncKind(value: string): value is SyncKind {
  return SYNC_KINDS.some((each) => each === value);
}

// Every call carries ADMIN_TOKEN as a bearer, so a mistyped scheme would put
// the Worker's admin credential on the wire in the clear. wrangler dev serves
// loopback over http, which is the one place that cannot be helped.
function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${value} is not a URL`);
  }
  if (url.protocol !== "https:" && !LOOPBACK.has(url.hostname)) {
    fail(`${value} is not https, and ADMIN_TOKEN would travel in the clear`);
  }
  return url;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
