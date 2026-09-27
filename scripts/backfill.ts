#!/usr/bin/env bun
// Drives POST /admin/backfill to completion. One call walks BACKFILL_WINDOWS
// windows and answers with where the next one resumes, so the walk over a
// decade of history is a loop out here rather than one long request in there.
// A call the rate budget or a secondary limit stopped names when to resume, and
// the loop sleeps until then.
//
// Usage: ADMIN_TOKEN=... bun run backfill <base-url> [kind] [--from YYYY-MM]

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
  next: z.string().nullable(),
  resumeAt: z.string().nullable(),
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
// A resume point belongs to the kind that stopped there. Applying it to all
// four would start the ones still behind it past history they never walked,
// and they would report done with the gap left in place.
if (flags.from !== undefined && requested === undefined) {
  fail("--from resumes one kind, so name which one");
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
  // Undefined leaves `from` off the first request so the route picks its own start.
  let from = flags.from;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await backfill(kind, from);
    console.log(describe(result));

    const wait = result.resumeAt === null ? null : Date.parse(result.resumeAt) - Date.now();
    if (result.error !== null && result.resumeAt === null) {
      throw new Error(`${kind} stopped, resume with: ${kind} --from ${result.next ?? "the start"}`);
    }
    if (result.next === null) {
      return;
    }
    // A resume point that repeats the window just asked for, with nothing
    // landed and nothing to wait for, would spin here forever. A
    // BACKFILL_WINDOWS or a cap of 0 produces it.
    if (result.next === from && result.pages === 0 && (wait === null || wait <= 0)) {
      throw new Error(`${kind} did not advance past ${from}`);
    }
    if (wait !== null && wait > 0) {
      console.log(`${kind.padEnd(KIND_WIDTH)} waiting until ${result.resumeAt}`);
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(wait);
    }
    from = result.next;
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
  const resume = result.next === null ? "done" : `next ${result.next}`;
  const line = [
    result.kind.padEnd(KIND_WIDTH),
    range.padEnd(17),
    `pages ${result.pages}`.padEnd(11),
    `rows ${result.rowsChanged}`.padEnd(12),
    resume,
  ].join(" ");
  return result.error === null ? line : `${line}  ${result.error}`;
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
