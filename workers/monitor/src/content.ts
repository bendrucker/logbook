import { parquetReadObjects } from "hyparquet";
import { Instapaper } from "instapaper-api";
import { z } from "zod";
import type { Metric } from "./metrics";

const USER_AGENT = "logbook-monitor (+https://github.com/bendrucker/logbook)";

// A source's newest item in the lake, and the oldest item upstream that is
// newer than it. The gap between that item and now is how long the lake has
// lacked something a reader would expect, which is the symptom a revoked
// credential or a stalled sync produces. A quiet week upstream has nothing
// newer, so it reads as zero rather than as stale.
export interface ContentSource {
  name: string;
  table: string;
  column: string;
  // Keeps only the rows the upstream query can return, so the lake's newest
  // is measured against the same population.
  where?: { column: string; equals: string };
  oldestAfter: (since: Date) => Promise<Date | null>;
}

export interface ContentEnv {
  GITHUB_LOGIN: string;
  GITHUB_TOKEN?: string;
  TRAKT_USER: string;
  TRAKT_CLIENT_ID: string;
  INSTAPAPER_ACCESS_TOKEN?: string;
}

// Sources without the credential they need are left out, and say so, rather
// than reading as a lag of zero.
export function contentSources(env: ContentEnv): ContentSource[] {
  const sources = [
    github(env.GITHUB_LOGIN, env.GITHUB_TOKEN),
    trakt(env.TRAKT_USER, env.TRAKT_CLIENT_ID),
  ];
  if (env.INSTAPAPER_ACCESS_TOKEN === undefined || env.INSTAPAPER_ACCESS_TOKEN === "") {
    console.log({ event: "monitor.content.skipped", source: "instapaper", reason: "no token" });
  } else {
    sources.push(instapaper(env.INSTAPAPER_ACCESS_TOKEN));
  }
  return sources;
}

// `content.lag_seconds` per source. A source whose probe throws is logged and
// left out, so one upstream outage leaves the others measured.
export async function collectContent(
  bucket: R2Bucket,
  sources: ContentSource[],
  now: Date,
): Promise<Metric[]> {
  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const newest = await newestInLake(bucket, source);
      const missing = await source.oldestAfter(newest ?? new Date(0));
      const lag = missing === null ? 0 : Math.max(0, now.getTime() - missing.getTime());
      return { metric: "content.lag_seconds", target: source.name, value: Math.round(lag / 1000) };
    }),
  );
  const metrics: Metric[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      metrics.push(result.value);
    } else {
      console.error({
        event: "monitor.content.failed",
        source: sources[index]?.name,
        error: String(result.reason),
      });
    }
  }
  return metrics;
}

const instant = z
  .union([z.date(), z.number(), z.bigint()])
  .transform((value) => new Date(Number(value)));

export async function newestInLake(bucket: R2Bucket, source: ContentSource): Promise<Date | null> {
  const key = `${source.table}/part-0.parquet`;
  const head = await bucket.head(key);
  if (head === null) {
    return null;
  }
  const file = {
    byteLength: head.size,
    slice: async (start: number, end?: number) => {
      const body = await bucket.get(key, {
        range: { offset: start, length: (end ?? head.size) - start },
      });
      if (body === null) {
        throw new Error(`${key} vanished mid-read`);
      }
      return body.arrayBuffer();
    },
  };
  const columns =
    source.where === undefined ? [source.column] : [source.column, source.where.column];
  const rows = await parquetReadObjects({ file, columns });
  let newest: number | null = null;
  for (const row of rows) {
    const value: unknown = row[source.column];
    if (value === null || value === undefined) {
      continue;
    }
    if (source.where !== undefined && row[source.where.column] !== source.where.equals) {
      continue;
    }
    const at = instant.parse(value).getTime();
    newest = newest === null ? at : Math.max(newest, at);
  }
  return newest === null ? null : new Date(newest);
}

const searchResponse = z.object({ items: z.array(z.object({ created_at: z.iso.datetime() })) });

// Pull requests the login opened, the population the lake's `author` filter
// keeps. Search answers unauthenticated for public data, so the token only
// raises the rate limit.
export function github(login: string, token?: string): ContentSource {
  return {
    name: "github",
    table: "github/v1/pull_requests",
    column: "created_at",
    where: { column: "author", equals: login },
    oldestAfter: async (since) => {
      const q = `type:pr author:${login} created:>${since.toISOString().slice(0, 19)}Z`;
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=asc&per_page=1`;
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
      };
      if (token !== undefined && token !== "") {
        headers.authorization = `Bearer ${token}`;
      }
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`GitHub search answered ${response.status}`);
      }
      const [item] = searchResponse.parse(await response.json()).items;
      return item === undefined ? null : new Date(item.created_at);
    },
  };
}

const historyResponse = z.array(z.object({ watched_at: z.iso.datetime() }));

// History is newest first, so the oldest play after `since` is the last page
// of a one-item listing.
export function trakt(user: string, clientId: string): ContentSource {
  const get = async (since: Date, page: number) => {
    const start = new Date(since.getTime() + 1000).toISOString();
    const response = await fetch(
      `https://api.trakt.tv/users/${user}/history?start_at=${start}&limit=1&page=${page}`,
      {
        headers: {
          "content-type": "application/json",
          "trakt-api-version": "2",
          "trakt-api-key": clientId,
          "user-agent": USER_AGENT,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Trakt history answered ${response.status}`);
    }
    return {
      count: Number(response.headers.get("x-pagination-item-count") ?? 0),
      body: await response.json(),
    };
  };
  return {
    name: "trakt",
    table: "trakt/v1/plays",
    column: "watched_at",
    oldestAfter: async (since) => {
      const { count } = await get(since, 1);
      if (count === 0) {
        return null;
      }
      const [play] = historyResponse.parse((await get(since, count)).body);
      return play === undefined ? null : new Date(play.watched_at);
    },
  };
}

// The change listing returns every bookmark touched since `since`, including
// old ones whose progress moved, so only those saved after it count. One page
// holds 500 changes, which an hour of reading never approaches.
export function instapaper(accessToken: string): ContentSource {
  const sdk = new Instapaper({
    accessToken,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  return {
    name: "instapaper",
    table: "instapaper/v1/bookmarks",
    column: "saved_at",
    oldestAfter: async (since) => {
      const seconds = Math.floor(since.getTime() / 1000);
      const { bookmarks } = await sdk.bookmarks.changes(seconds, { limit: 500 });
      const saved = bookmarks.map(({ time }) => time).filter((time) => time > seconds);
      return saved.length === 0 ? null : new Date(Math.min(...saved) * 1000);
    },
  };
}
