import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type CrawlSource, drain, enqueue, frontierStatus, type UnitFetch } from "./frontier";

const FETCHED_AT = "2026-09-09T12:00:00.000Z";

function fetched(overrides: Partial<UnitFetch> = {}): UnitFetch {
  return {
    fetchedAt: FETCHED_AT,
    pages: 1,
    rowsChanged: 0,
    cost: 1,
    truncated: false,
    error: null,
    resumeAt: null,
    ...overrides,
  };
}

// Windows are strings of digits. Any window shorter than `whole` comes back
// truncated and splits by appending a digit, and one at `finest` cannot split.
function fakeSource(options: { whole: number; finest: number; failOn?: string }) {
  const fetches: string[] = [];
  const source: CrawlSource = {
    fetch: (window) => {
      fetches.push(window);
      return Promise.resolve(
        window === options.failOn
          ? fetched({ error: "BudgetRefused: floor", resumeAt: "2026-09-09T13:00:00Z" })
          : fetched({ truncated: window.length < options.whole }),
      );
    },
    split: (window) => (window.length >= options.finest ? [] : [`${window}0`, `${window}1`]),
  };
  return { source, fetches };
}

function units() {
  return env.DB.prepare(
    "SELECT window, parent, status, pages, cost FROM crawl_units WHERE kind = 'fake' ORDER BY window",
  )
    .all()
    .then(({ results }) => results);
}

describe("drain", () => {
  it("splits truncated windows down to leaves, each subtree before the next root", async () => {
    await enqueue(env.DB, "fake", ["1", "2"]);
    const { source, fetches } = fakeSource({ whole: 2, finest: 3 });

    const result = await drain(env.DB, "fake", source);

    expect(fetches).toEqual(["1", "10", "11", "2", "20", "21"]);
    expect(result).toMatchObject({ pages: 6, resumeAt: null, error: null });
    expect(await units()).toContainEqual({
      window: "1",
      parent: null,
      status: "split",
      pages: 1,
      cost: 1,
    });
    expect(await units()).toContainEqual({
      window: "10",
      parent: "1",
      status: "done",
      pages: 1,
      cost: 1,
    });
  });

  it("marks a window truncated at the finest split irreducible", async () => {
    await enqueue(env.DB, "fake", ["1"]);
    const { source } = fakeSource({ whole: 9, finest: 2 });

    await drain(env.DB, "fake", source);

    expect(await frontierStatus(env.DB)).toEqual(
      new Map([["fake", { pending: 0, irreducible: ["10", "11"] }]]),
    );
  });

  it("stops on a unit that fails and resumes there without refetching what finished", async () => {
    await enqueue(env.DB, "fake", ["1", "2"]);
    const stopping = fakeSource({ whole: 2, finest: 3, failOn: "11" });

    const stopped = await drain(env.DB, "fake", stopping.source);

    expect(stopped).toMatchObject({
      windows: ["1", "10", "11"],
      resumeAt: "2026-09-09T13:00:00Z",
      error: "BudgetRefused: floor",
    });
    expect((await frontierStatus(env.DB)).get("fake")?.pending).toBe(2);

    const resuming = fakeSource({ whole: 2, finest: 3 });
    await drain(env.DB, "fake", resuming.source);

    expect(resuming.fetches).toEqual(["11", "2", "20", "21"]);
  });

  it("keeps the status of a window enqueued again", async () => {
    await enqueue(env.DB, "fake", ["1"]);
    await drain(env.DB, "fake", fakeSource({ whole: 1, finest: 1 }).source);

    await enqueue(env.DB, "fake", ["1", "2"]);

    expect(await frontierStatus(env.DB)).toEqual(
      new Map([["fake", { pending: 1, irreducible: [] }]]),
    );
  });
});
