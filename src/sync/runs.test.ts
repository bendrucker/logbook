import { env } from "cloudflare:workers";
import { describe, expect, it, test } from "vitest";
import {
  finishRun,
  lastRuns,
  recentFailures,
  recentRuns,
  spendSince,
  startRun,
  type RunResult,
} from "./runs";

const ok: RunResult = {
  pages: 3,
  rowsChanged: 12,
  truncated: false,
  error: null,
  note: null,
  cost: 3,
  rateRemaining: 4200,
};

describe("startRun", () => {
  it("records a run that has not finished", async () => {
    const id = await startRun(
      env.DB,
      "pr-authored",
      "2026-09-01..2026-09-08",
      "2026-09-09T18:00:00Z",
    );

    expect(await recentRuns(env.DB, "pr-authored", 10)).toEqual([
      {
        id,
        kind: "pr-authored",
        window: "2026-09-01..2026-09-08",
        startedAt: "2026-09-09T18:00:00Z",
        finishedAt: null,
        pages: 0,
        rowsChanged: 0,
        truncated: false,
        error: null,
        note: null,
        cost: 0,
        rateRemaining: null,
      },
    ]);
  });
});

describe("finishRun", () => {
  // A failed run reports the counts it reached, so both rows read back the same
  // fields rather than treating an error as the only thing worth asserting.
  test.each<{ name: string; result: RunResult }>([
    {
      name: "a clean run",
      result: {
        pages: 2,
        rowsChanged: 7,
        truncated: true,
        error: null,
        note: null,
        cost: 2,
        rateRemaining: 4100,
      },
    },
    {
      name: "a run that gave up partway",
      result: {
        pages: 1,
        rowsChanged: 4,
        truncated: false,
        error: "secondary rate limit",
        note: null,
        cost: 1,
        rateRemaining: null,
      },
    },
  ])("closes $name with what it wrote", async ({ result }) => {
    const id = await startRun(env.DB, "issue", "2026-09-01..2026-09-08", "2026-09-09T18:00:00Z");

    await finishRun(env.DB, id, result, "2026-09-09T18:01:00Z");

    expect(await recentRuns(env.DB, "issue", 10)).toEqual([
      {
        id,
        kind: "issue",
        window: "2026-09-01..2026-09-08",
        startedAt: "2026-09-09T18:00:00Z",
        finishedAt: "2026-09-09T18:01:00Z",
        ...result,
      },
    ]);
  });
});

describe("recentRuns", () => {
  it("reads newest first, up to the limit", async () => {
    for (const started of [
      "2026-09-07T18:00:00Z",
      "2026-09-08T18:00:00Z",
      "2026-09-09T18:00:00Z",
    ]) {
      await startRun(env.DB, "pr-authored", started.slice(0, 10), started);
    }

    const runs = await recentRuns(env.DB, "pr-authored", 2);

    expect(runs.map((run) => run.startedAt)).toEqual([
      "2026-09-09T18:00:00Z",
      "2026-09-08T18:00:00Z",
    ]);
  });

  it("reads only its own kind", async () => {
    await startRun(env.DB, "contributions", "2026", "2026-09-09T18:00:00Z");

    expect(await recentRuns(env.DB, "pr-reviewed", 10)).toEqual([]);
  });
});

describe("lastRuns", () => {
  it("answers for every kind, run or not", async () => {
    const older = await startRun(env.DB, "issue", "2026-09-01", "2026-09-08T18:00:00Z");
    await finishRun(env.DB, older, ok, "2026-09-08T18:01:00Z");
    const newer = await startRun(env.DB, "issue", "2026-09-08", "2026-09-09T18:00:00Z");

    const runs = await lastRuns(env.DB);

    expect(runs.issue?.id).toBe(newer);
    expect(runs["pr-authored"]).toBeNull();
    expect(runs["pr-reviewed"]).toBeNull();
    expect(runs.contributions).toBeNull();
  });
});

describe("recentFailures", () => {
  it("reads failures across kinds, newest first", async () => {
    const clean = await startRun(env.DB, "pr-authored", "2026-09-01", "2026-09-07T18:00:00Z");
    await finishRun(env.DB, clean, ok, "2026-09-07T18:01:00Z");
    const failed = await startRun(env.DB, "issue", "2026-09-01", "2026-09-08T18:00:00Z");
    await finishRun(env.DB, failed, { ...ok, error: "502 from search" }, "2026-09-08T18:01:00Z");
    const alsoFailed = await startRun(env.DB, "contributions", "2026", "2026-09-09T18:00:00Z");
    await finishRun(env.DB, alsoFailed, { ...ok, error: "token expired" }, "2026-09-09T18:01:00Z");

    const failures = await recentFailures(env.DB, 10);

    expect(failures.map((run) => run.error)).toEqual(["token expired", "502 from search"]);
  });

  it("stops at the limit", async () => {
    for (const started of [
      "2026-09-07T18:00:00Z",
      "2026-09-08T18:00:00Z",
      "2026-09-09T18:00:00Z",
    ]) {
      const id = await startRun(env.DB, "issue", started.slice(0, 10), started);
      await finishRun(env.DB, id, { ...ok, error: "502 from search" }, started);
    }

    expect(await recentFailures(env.DB, 2)).toHaveLength(2);
  });
});

describe("spendSince", () => {
  it("reads what every kind spent from the instant on", async () => {
    for (const [kind, started, cost] of [
      ["issue", "2026-09-09T17:00:00.000Z", 5],
      ["pr-authored", "2026-09-09T18:00:00.000Z", 3],
      ["contributions", "2026-09-09T18:30:00.000Z", 2],
      ["issue", "2026-09-09T18:40:00.000Z", 0],
    ] as const) {
      const id = await startRun(env.DB, kind, started.slice(0, 10), started);
      await finishRun(env.DB, id, { ...ok, cost }, started);
    }

    expect(await spendSince(env.DB, "2026-09-09T18:00:00.000Z")).toEqual([
      { startedAt: "2026-09-09T18:00:00.000Z", cost: 3 },
      { startedAt: "2026-09-09T18:30:00.000Z", cost: 2 },
    ]);
  });
});
