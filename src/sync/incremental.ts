import { type EventKind, incrementalSearch } from "../github/windows";
import { type Budget, openBudget, syncLimits } from "./budget";
import { SEARCH_KINDS, type SyncKind } from "./kinds";
import {
  githubToken,
  type InvocationOptions,
  MissingSecretError,
  syncContributions,
  type SyncResult,
  syncWindow,
} from "./run";
import { readWatermark } from "./state";

// GitHub's search index lags writes by an unspecified interval, so the window
// opens behind the watermark instead of at it. An hour covers the lag, and the
// overlap costs nothing against upserts keyed on node ID.
const OVERLAP_MS = 60 * 60 * 1000;

export async function syncIncremental(env: Env, options: InvocationOptions = {}): Promise<void> {
  const now = options.now ?? new Date();

  try {
    githubToken(env);
  } catch (error) {
    if (!(error instanceof MissingSecretError)) {
      throw error;
    }
    // A cron that throws retries on the next hour and reports nothing useful in
    // between, and no amount of retrying sets a secret.
    console.error(error.message);
    return;
  }

  const budget = await openBudget(env.DB, syncLimits(env), { now, clock: options.clock });
  const sync = { ...options, now, budget };

  // The kinds run one after another so the budget limit the first one reaches
  // stops the invocation, rather than three concurrent runs each spending their
  // way to the same discovery.
  const remaining = [...SEARCH_KINDS];
  let kind = remaining.shift();
  while (kind !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    const result = await contained(kind, syncKind(env, kind, sync));
    if (result !== null && result.resumeAt !== null) {
      return;
    }
    kind = remaining.shift();
  }

  await contained("contributions", syncContributions(env, now.getUTCFullYear(), sync));
}

// One kind's storage failure is not the other kinds' problem, and a throw here
// would end the invocation before they ran.
async function contained(
  kind: SyncKind,
  run: Promise<SyncResult | null>,
): Promise<SyncResult | null> {
  try {
    return await run;
  } catch (error) {
    console.error(`${kind} sync failed: ${String(error)}`);
    return null;
  }
}

async function syncKind(
  env: Env,
  kind: EventKind,
  options: InvocationOptions & { now: Date; budget: Budget },
): Promise<SyncResult | null> {
  const { now } = options;
  const watermark = await readWatermark(env.DB, kind);
  if (watermark === null) {
    // Anchoring at now would declare every event before this invocation synced
    // and leave the history unreachable except by replay.
    console.log(`${kind} has no watermark, so a backfill owns its first window`);
    return null;
  }

  const since = new Date(Date.parse(watermark.window) - OVERLAP_MS).toISOString();

  return syncWindow(
    env,
    kind,
    {
      key: `updated:${since}`,
      query: incrementalSearch(kind, env.GITHUB_LOGIN, since),
      through: now.toISOString(),
    },
    options,
  );
}
