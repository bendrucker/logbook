import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeClock } from "../../test/clock";
import { stubFetch } from "../../test/fetch-stub";
import {
  jsonResponse,
  pullRequest,
  rateLimit,
  type RateLimitOverrides,
  searchPayload,
} from "../../test/github-fixtures";
import {
  backfillLimits,
  Budget,
  type BudgetLimits,
  BudgetRefused,
  openBudget,
  syncLimits,
} from "./budget";
import { syncWindow } from "./run";
import { finishRun, startRun } from "./runs";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const RESET_AT = "2026-09-09T12:30:00Z";

const LOOSE: BudgetLimits = { floor: 0, share: 5000, cap: 1000, spacingMs: 0 };

beforeEach(async () => {
  env.GITHUB_TOKEN = "token";
  const listed = await env.RAW.list();
  await env.RAW.delete(listed.objects.map((object) => object.key));
});

// Every page announces a successor, so only the budget ends the window.
function endlessSearch(readings: readonly RateLimitOverrides[]) {
  let served = 0;
  return stubFetch(() => {
    const reading = readings[Math.min(served, readings.length - 1)];
    served += 1;
    const payload = searchPayload([pullRequest(served)], { endCursor: `cursor-${served}` });
    return jsonResponse({
      data: { ...payload.data, rateLimit: rateLimit({ resetAt: RESET_AT, ...reading }) },
    });
  });
}

function window(key: string) {
  return { key, query: "is:pr author:bendrucker", through: "2026-09-30T23:59:59Z", splits: false };
}

async function seedRun(startedAt: string, cost: number): Promise<void> {
  const id = await startRun(env.DB, "issue", startedAt.slice(0, 10), startedAt);
  await finishRun(
    env.DB,
    id,
    { pages: 1, rowsChanged: 0, truncated: false, error: null, note: null, cost, rateRemaining: 0 },
    startedAt,
  );
}

describe("Budget", () => {
  it.each([
    { name: "incremental sync", limits: () => syncLimits(env), requests: 5 },
    { name: "backfill", limits: () => backfillLimits(env), requests: 3 },
  ])("stops the $name at its floor as remaining falls", async ({ limits, requests }) => {
    const stub = endlessSearch([
      { remaining: 4000 },
      { remaining: 3000 },
      { remaining: 2400 },
      { remaining: 1500 },
      { remaining: 900 },
    ]);
    const budget = new Budget(limits(), [], fakeClock().clock);

    const result = await syncWindow(env, "pr-authored", window("2026-09"), {
      fetch: stub.fetch,
      now: NOW,
      budget,
    });

    expect(stub.requests).toHaveLength(requests);
    expect(result.error).toContain("BudgetRefused");
    expect(result.error).toContain("floor");
    expect(result.resumeAt).toBe(RESET_AT);
  });

  it("refuses the next request once earlier runs have spent the window's share", async () => {
    // Inside the window that resets at 12:30, and one before it that does not count.
    await seedRun("2026-09-09T11:40:00.000Z", 298);
    await seedRun("2026-09-09T11:10:00.000Z", 500);
    const stub = endlessSearch([{ remaining: 4000 }]);
    const budget = await openBudget(env.DB, { ...LOOSE, share: 300 }, { now: NOW });

    const result = await syncWindow(env, "pr-authored", window("2026-09"), {
      fetch: stub.fetch,
      now: NOW,
      budget,
    });

    // 298 before and two pages reach the share of 300, so a third would pass it.
    expect(stub.requests).toHaveLength(2);
    expect(result.error).toContain("share");
    expect(result.resumeAt).toBe(RESET_AT);
  });

  it("stops at the invocation cap partway through a later window", async () => {
    const stub = endlessSearch([{ remaining: 4000 }]);
    const budget = new Budget({ ...LOOSE, cap: 3 });
    const options = { fetch: stub.fetch, now: NOW, budget };

    const first = await syncWindow(env, "pr-authored", window("2026-08"), options);
    const second = await syncWindow(env, "pr-authored", window("2026-09"), options);

    expect(stub.requests).toHaveLength(3);
    expect(first).toMatchObject({ pages: 3, cost: 3 });
    expect(second).toMatchObject({ pages: 0, cost: 0, resumeAt: NOW.toISOString() });
    expect(second.error).toContain("cap");
  });

  it("starts the share over when the provider's window resets", async () => {
    const budget = new Budget({ ...LOOSE, share: 2 });
    budget.spend(rateLimit({ resetAt: "2026-09-09T12:00:00Z" }));
    budget.spend(rateLimit({ resetAt: "2026-09-09T12:00:00Z" }));
    await expect(budget.admit()).rejects.toThrow(BudgetRefused);

    budget.spend(rateLimit({ resetAt: "2026-09-09T13:00:00Z" }));

    await expect(budget.admit()).resolves.toBeUndefined();
    expect(budget.spent).toBe(3);
  });

  it("spaces requests from when the previous one went out", async () => {
    const { clock, waits, advance } = fakeClock();
    const budget = new Budget({ ...LOOSE, spacingMs: 1000 }, [], clock);

    await budget.admit();
    advance(300);
    await budget.admit();
    advance(1500);
    await budget.admit();

    expect(waits).toEqual([700]);
  });

  it("keeps the spend and reading under other limits", async () => {
    const budget = new Budget({ ...LOOSE, cap: 3 });
    budget.spend(rateLimit({ remaining: 2000 }));
    budget.spend(rateLimit({ remaining: 1999 }));

    const stricter = budget.withLimits({ floor: 2500 });
    await expect(stricter.admit()).rejects.toMatchObject({ limit: "floor" });

    const looser = budget.withLimits({ floor: 0 });
    await looser.admit();
    looser.spend(rateLimit({ remaining: 1998 }));
    await expect(looser.admit()).rejects.toMatchObject({ limit: "cap" });
    expect(looser.spent).toBe(3);
  });

  it("refuses without waiting", async () => {
    const { clock, waits } = fakeClock();
    const budget = new Budget({ ...LOOSE, cap: 1, spacingMs: 1000 }, [], clock);

    await budget.admit();
    budget.spend(rateLimit());

    await expect(budget.admit()).rejects.toMatchObject({ limit: "cap", resetAt: null });
    expect(waits).toEqual([]);
  });
});
