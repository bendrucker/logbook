import type { RateLimit } from "../github/schema";
import { type RunSpend, spendSince } from "./runs";

// GitHub's GraphQL budget refills on an hourly window that ends at `resetAt`.
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Every request observed so far costs one point, so a budget with no reading
// yet expects the first to cost the same.
const EXPECTED_COST = 1;

// GitHub documents 30 searches a minute for REST search and doesn't document a
// limit for GraphQL search. A backfill assumes the same limit applies.
export const BACKFILL_SPACING_MS = 2000;

export interface BudgetLimits {
  // The provider's reported remaining quota never goes below this.
  floor: number;
  // The most spent between one reset and the next, however much is left.
  share: number;
  // The most one invocation spends, which bounds its wall clock and
  // subrequests.
  cap: number;
  // The least time between one request going out and the next.
  spacingMs: number;
}

export function syncLimits(env: Env): BudgetLimits {
  return {
    floor: env.RATE_FLOOR_SYNC,
    share: env.RATE_SHARE,
    cap: env.RATE_CAP_CRON,
    spacingMs: 0,
  };
}

export function backfillLimits(env: Env): BudgetLimits {
  return {
    floor: env.RATE_FLOOR_BACKFILL,
    share: env.RATE_SHARE,
    cap: env.RATE_CAP_BACKFILL,
    spacingMs: BACKFILL_SPACING_MS,
  };
}

export type BudgetLimit = "floor" | "share" | "cap";

// Thrown before a request goes out, so a refusal spends nothing and carries no
// response.
export class BudgetRefused extends Error {
  readonly limit: BudgetLimit;
  // When the refused limit frees up: the provider's reset for the floor and the
  // share. Null for the cap, which the next invocation starts fresh.
  readonly resetAt: string | null;

  constructor(limit: BudgetLimit, detail: string, resetAt: string | null) {
    super(`rate budget refused a request at its ${limit}: ${detail}`);
    this.name = "BudgetRefused";
    this.limit = limit;
    this.resetAt = resetAt;
  }
}

export interface Clock {
  now(): number;
  wait(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  wait: (ms) => scheduler.wait(ms),
};

// One per invocation. The ledger is what earlier invocations spent, read from
// `sync_runs`, and the budget adds its own spend to it as responses land.
export class Budget {
  readonly #limits: BudgetLimits;
  readonly #ledger: readonly RunSpend[];
  readonly #clock: Clock;
  #spent = 0;
  #spentThisWindow = 0;
  #reading: RateLimit | null = null;
  #lastRequest: number | null = null;

  constructor(limits: BudgetLimits, ledger: readonly RunSpend[] = [], clock = SYSTEM_CLOCK) {
    this.#limits = limits;
    this.#ledger = ledger;
    this.#clock = clock;
  }

  // Points this invocation has spent.
  get spent(): number {
    return this.#spent;
  }

  // The last `remaining` the provider reported, null before the first response.
  get remaining(): number | null {
    return this.#reading?.remaining ?? null;
  }

  // The same spend and reading under other limits, for work an invocation does
  // after its own: the cron drains backfill windows at the backfill floor, and
  // the cap still counts what the incremental sync spent.
  withLimits(limits: Partial<BudgetLimits>): Budget {
    const budget = new Budget({ ...this.#limits, ...limits }, this.#ledger, this.#clock);
    budget.#spent = this.#spent;
    budget.#spentThisWindow = this.#spentThisWindow;
    budget.#reading = this.#reading;
    budget.#lastRequest = this.#lastRequest;
    return budget;
  }

  async admit(): Promise<void> {
    this.#check();

    if (this.#lastRequest !== null) {
      const wait = this.#lastRequest + this.#limits.spacingMs - this.#clock.now();
      if (wait > 0) {
        await this.#clock.wait(wait);
      }
    }
    this.#lastRequest = this.#clock.now();
  }

  spend(reading: RateLimit): void {
    if (this.#reading?.resetAt !== reading.resetAt) {
      this.#spentThisWindow = 0;
    }
    this.#spent += reading.cost;
    this.#spentThisWindow += reading.cost;
    this.#reading = reading;
  }

  #check(): void {
    const { floor, share, cap } = this.#limits;
    const reading = this.#reading;
    const expected = reading?.cost ?? EXPECTED_COST;

    if (this.#spent + expected > cap) {
      throw new BudgetRefused("cap", `spent ${this.#spent} of ${cap} this invocation`, null);
    }

    // The window a request spends from is known only from a response, so the
    // first request goes out on the cap alone and its reading governs the rest.
    if (reading === null) {
      return;
    }

    if (reading.remaining - expected < floor) {
      throw new BudgetRefused(
        "floor",
        `${reading.remaining} remaining against a floor of ${floor}`,
        reading.resetAt,
      );
    }

    const spent = this.#windowSpend(reading.resetAt);
    if (spent + expected > share) {
      throw new BudgetRefused(
        "share",
        `spent ${spent} of ${share} this rate window`,
        reading.resetAt,
      );
    }
  }

  // Runs are attributed to the window they started in, which is close enough
  // for runs that each spend a handful of points.
  #windowSpend(resetAt: string): number {
    const start = Date.parse(resetAt) - RATE_WINDOW_MS;
    const earlier = this.#ledger
      .filter((run) => Date.parse(run.startedAt) >= start)
      .reduce((total, run) => total + run.cost, 0);
    return earlier + this.#spentThisWindow;
  }
}

export interface BudgetOptions {
  now?: Date;
  clock?: Clock;
}

// The current window started less than an hour before now, so the trailing
// hour holds every run that could count against it.
export async function openBudget(
  db: D1Database,
  limits: BudgetLimits,
  options: BudgetOptions = {},
): Promise<Budget> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - RATE_WINDOW_MS).toISOString();
  return new Budget(limits, await spendSince(db, since), options.clock);
}
