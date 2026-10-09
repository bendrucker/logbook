#!/usr/bin/env bun
// Imports the Apple Music files of an Apple privacy export. Each file is read
// here, cut down to the columns `src/apple-music/export.ts` allows, and posted
// to /admin/import/apple-music a page at a time, so the IP address, location,
// and device identifiers on every play event never leave this machine. A last
// call resolves artists and refreshes the candidate tracks.
//
// `--out <dir>` writes the pages there instead of posting them, to read what
// an import would send.

import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  EXPORT_FILES,
  type ExportFile,
  type ExportRecord,
  parseCsv,
  project,
  SOURCE_FILES,
} from "../src/apple-music/export";
import { adminToken, fail, parseUrl } from "./admin-client";

const USAGE =
  "usage: ADMIN_TOKEN=... bun run import:apple-music <Apple Music Activity dir> <base-url> [--export YYYY-MM-DD]\n" +
  "       bun run import:apple-music <Apple Music Activity dir> --out <dir> [--export YYYY-MM-DD]";

// A play page of 500 events is a few hundred kilobytes and one D1 batch of 500
// upserts, the same batch an Instapaper page writes.
const PAGE_SIZE = 500;

const FILE_WIDTH = Math.max(...EXPORT_FILES.map((file) => file.length));

const ImportResult = z.object({ records: z.number(), rowsChanged: z.number() });
const FinishResult = z.object({
  artistsChanged: z.number(),
  tracksChanged: z.number(),
  plays: z.number(),
  unresolved: z.number(),
  tracks: z.number(),
});

const LibraryTracks = z.array(z.record(z.string(), z.unknown()));

const { values: flags, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    export: { type: "string" },
    out: { type: "string" },
  },
  allowPositionals: true,
});

const [exportDir, target] = positionals;
if (exportDir === undefined || (target === undefined) === (flags.out === undefined)) {
  fail(USAGE);
}

try {
  const exportId = flags.export ?? (await exportDate(exportDir));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exportId)) {
    fail(`--export ${exportId} is not YYYY-MM-DD`);
  }
  const send =
    flags.out === undefined ? poster(parseUrl(target ?? ""), exportId) : writer(flags.out);

  for (const file of EXPORT_FILES) {
    // oxlint-disable-next-line no-await-in-loop -- one file's records in memory at a time
    const records = (await readFile(exportDir, file)).map((record) => project(file, record));
    const pages = chunk(records, PAGE_SIZE);
    let changed = 0;
    for (const [index, page] of pages.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- pages post one at a time to keep each invocation small
      changed += await send.page(file, index + 1, page);
    }
    const counts = `${file.padEnd(FILE_WIDTH)} ${exportId} records ${records.length}`;
    console.log(`${counts.padEnd(48)}${`pages ${pages.length}`.padEnd(10)}rows ${changed}`);
  }

  await send.finish();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

interface Sender {
  page: (file: ExportFile, page: number, records: ExportRecord[]) => Promise<number>;
  finish: () => Promise<void> | void;
}

function poster(base: URL, exportId: string): Sender {
  const token = adminToken();
  const post = async (url: URL, body?: string): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`POST ${url.pathname}${url.search} answered ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  };

  return {
    page: async (file, page, records) => {
      const url = new URL("/admin/import/apple-music", base);
      url.search = new URLSearchParams({ export: exportId, file, page: String(page) }).toString();
      return ImportResult.parse(await post(url, JSON.stringify(records))).rowsChanged;
    },
    finish: async () => {
      const result = FinishResult.parse(
        await post(new URL("/admin/import/apple-music/finish", base)),
      );
      console.log(
        `tracks ${result.tracks} from ${result.plays} plays, ` +
          `${result.unresolved} with no artist, ${result.tracksChanged} tracks changed`,
      );
    },
  };
}

function writer(out: string): Sender {
  return {
    page: async (file, page, records) => {
      const dir = path.join(out, file);
      await mkdir(dir, { recursive: true });
      await Bun.write(path.join(dir, `${page}.json`), JSON.stringify(records, null, 2));
      return 0;
    },
    finish: () => {
      console.log(`pages written under ${out}`);
    },
  };
}

async function readFile(directory: string, file: ExportFile): Promise<ExportRecord[]> {
  const source = path.join(directory, SOURCE_FILES[file]);
  if (file === "library-tracks") {
    return LibraryTracks.parse(JSON.parse(await unzip(source)));
  }
  return parseCsv(await Bun.file(source).text());
}

async function unzip(archive: string): Promise<string> {
  const child = Bun.spawn(["unzip", "-p", archive], { stdout: "pipe", stderr: "pipe" });
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`unzip ${archive} exited ${code}: ${error}`);
  }
  return text;
}

// Apple writes every file of an export in one pass, so the play log's
// modification day names the export.
async function exportDate(directory: string): Promise<string> {
  const { mtime } = await stat(path.join(directory, SOURCE_FILES["play-activity"]));
  return mtime.toISOString().slice(0, 10);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    pages.push(items.slice(start, start + size));
  }
  return pages;
}
