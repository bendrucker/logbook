import { GitHubHttpError, GraphQLQueryError, SecondaryRateLimited } from "../github/client";
import { InstapaperRateLimited, InstapaperResponseError } from "../instapaper/client";
import { RequestCapReached } from "../request-cap";
import { TraktHttpError, TraktRateLimited } from "../trakt/client";
import { BudgetRefused } from "./budget";

// How a run ended. A rate limit is its own outcome rather than a failure or a
// skip: the run did real work and stopped early, which costs freshness rather
// than correctness, and is the commonest way an extraction stops.
export type Outcome = "ok" | "rate_limited" | "failed" | "skipped";

// Why a run that did not end `ok` ended the way it did. The prefix names the
// outcome's family, so a query can group on everything before the dot.
export type Reason =
  // The upstream answered 429.
  | "rate_limit.upstream"
  // GitHub's secondary limit, which answers to burst shape rather than volume.
  | "rate_limit.secondary"
  // Our own budget or request cap refused before a request went out, which is
  // tuned by the `RATE_*` vars rather than by the upstream.
  | "rate_limit.budget"
  | "upstream.5xx"
  | "upstream.4xx"
  // GraphQL answered with an `errors` array.
  | "upstream.graphql"
  // A response failed validation or broke the API's own rules, such as a
  // repeated cursor: the upstream changed, or our reading of it was wrong.
  | "upstream.contract"
  // A missing secret or an unknown login, which no retry fixes.
  | "config"
  | "internal"
  | "skip.no_watermark"
  | "skip.backfill_pending"
  | "skip.missing_secret"
  // An earlier kind's rate limit ended the invocation before this one ran.
  | "skip.rate_limited";

export interface Classified {
  outcome: Outcome;
  reason: Reason | null;
}

export const OK: Classified = { outcome: "ok", reason: null };

const CONTRACT_ERRORS = new Set([
  "ResponseValidationError",
  "RepeatedCursorError",
  "TraktValidationError",
  "InstapaperValidationError",
]);

// By name, since `run.ts` classifies with this module and defines one of them.
const CONFIG_ERRORS = new Set(["MissingSecretError", "UnknownUserError"]);

export function classify(error: unknown): Classified {
  if (error instanceof TraktRateLimited || error instanceof InstapaperRateLimited) {
    return { outcome: "rate_limited", reason: "rate_limit.upstream" };
  }
  if (error instanceof SecondaryRateLimited) {
    return { outcome: "rate_limited", reason: "rate_limit.secondary" };
  }
  if (error instanceof BudgetRefused || error instanceof RequestCapReached) {
    return { outcome: "rate_limited", reason: "rate_limit.budget" };
  }
  if (error instanceof Error && CONTRACT_ERRORS.has(error.name)) {
    return { outcome: "failed", reason: "upstream.contract" };
  }
  if (error instanceof GraphQLQueryError) {
    return { outcome: "failed", reason: "upstream.graphql" };
  }
  if (
    error instanceof GitHubHttpError ||
    error instanceof TraktHttpError ||
    (error instanceof InstapaperResponseError && error.name === "InstapaperApiError")
  ) {
    return { outcome: "failed", reason: error.status >= 500 ? "upstream.5xx" : "upstream.4xx" };
  }
  if (error instanceof Error && CONFIG_ERRORS.has(error.name)) {
    return { outcome: "failed", reason: "config" };
  }
  return { outcome: "failed", reason: "internal" };
}
