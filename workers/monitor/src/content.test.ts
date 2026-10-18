import { env } from "cloudflare:workers";
import { parquetWriteBuffer } from "hyparquet-writer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectContent, type ContentSource, github, newestInLake, trakt } from "./content";

const NOW = new Date("2026-10-18T12:00:00Z");

beforeEach(async () => {
  const listed = await env.LAKE.list();
  await env.LAKE.delete(listed.objects.map((object) => object.key));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function putTable(table: string, columns: Record<string, (string | Date | null)[]>) {
  const columnData = Object.entries(columns).map(([name, data]) => ({
    name,
    type: data.some((value) => value instanceof Date)
      ? ("TIMESTAMP" as const)
      : ("STRING" as const),
    data,
  }));
  await env.LAKE.put(`${table}/part-0.parquet`, parquetWriteBuffer({ columnData }));
}

function requested(
  fetch: { mock: { calls: Parameters<typeof globalThis.fetch>[] } },
  call: number,
): URL {
  const input = fetch.mock.calls[call]?.[0];
  if (typeof input !== "string") {
    throw new TypeError("expected a URL string");
  }
  return new URL(input);
}

function source(overrides: Partial<ContentSource>): ContentSource {
  return {
    name: "test",
    table: "test/v1/items",
    column: "at",
    oldestAfter: () => Promise.resolve(null),
    ...overrides,
  };
}

describe("newestInLake", () => {
  it("reads the newest value of the column among rows the filter keeps", async () => {
    await putTable("test/v1/items", {
      at: [new Date("2026-10-16T00:00:00Z"), new Date("2026-10-17T00:00:00Z"), null],
      author: ["bendrucker", "someone-else", "bendrucker"],
    });

    const newest = await newestInLake(
      env.LAKE,
      source({ where: { column: "author", equals: "bendrucker" } }),
    );

    expect(newest).toEqual(new Date("2026-10-16T00:00:00Z"));
  });

  it("answers null for a table the lake lacks", async () => {
    expect(await newestInLake(env.LAKE, source({}))).toBeNull();
  });
});

describe("collectContent", () => {
  it("measures the lag from the oldest item the lake lacks", async () => {
    await putTable("test/v1/items", { at: [new Date("2026-10-16T00:00:00Z")] });
    const oldestAfter = vi.fn<ContentSource["oldestAfter"]>(() =>
      Promise.resolve(new Date("2026-10-17T12:00:00Z")),
    );

    const metrics = await collectContent(env.LAKE, [source({ oldestAfter })], NOW);

    expect(oldestAfter).toHaveBeenCalledWith(new Date("2026-10-16T00:00:00Z"));
    expect(metrics).toEqual([{ metric: "content.lag_seconds", target: "test", value: 86_400 }]);
  });

  it("reads a quiet source as no lag", async () => {
    await putTable("test/v1/items", { at: [new Date("2026-10-01T00:00:00Z")] });

    const metrics = await collectContent(env.LAKE, [source({})], NOW);

    expect(metrics).toEqual([{ metric: "content.lag_seconds", target: "test", value: 0 }]);
  });

  it("leaves out a source whose probe fails and measures the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = source({ name: "down", oldestAfter: () => Promise.reject(new Error("503")) });

    const metrics = await collectContent(env.LAKE, [failing, source({})], NOW);

    expect(metrics.map(({ target }) => target)).toEqual(["test"]);
  });
});

describe("github", () => {
  it("asks search for the login's oldest pull request after the lake's newest", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ items: [{ created_at: "2026-10-17T08:00:00Z" }] }));

    const oldest = await github("bendrucker").oldestAfter(new Date("2026-10-16T00:00:00.500Z"));

    expect(oldest).toEqual(new Date("2026-10-17T08:00:00Z"));
    const url = requested(fetch, 0);
    expect(url.searchParams.get("q")).toBe(
      "type:pr author:bendrucker created:>2026-10-16T00:00:00Z",
    );
    expect(url.searchParams.get("order")).toBe("asc");
  });
});

describe("trakt", () => {
  it("reads the last page of a one-item history listing", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json([{ watched_at: "2026-10-17T22:00:00.000Z" }], {
          headers: { "x-pagination-item-count": "3" },
        }),
      )
      .mockResolvedValueOnce(Response.json([{ watched_at: "2026-10-16T20:00:00.000Z" }]));

    const oldest = await trakt("bendrucker", "client").oldestAfter(
      new Date("2026-10-16T00:00:00Z"),
    );

    expect(oldest).toEqual(new Date("2026-10-16T20:00:00Z"));
    expect(requested(fetch, 1).searchParams.get("page")).toBe("3");
  });

  it("answers null when nothing is newer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([], { headers: { "x-pagination-item-count": "0" } }),
    );

    expect(await trakt("bendrucker", "client").oldestAfter(new Date())).toBeNull();
  });
});
