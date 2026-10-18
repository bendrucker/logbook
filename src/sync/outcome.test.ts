import { describe, expect, it } from "vitest";
import {
  GitHubHttpError,
  GraphQLQueryError,
  ResponseValidationError,
  SecondaryRateLimited,
} from "../github/client";
import { UnknownUserError } from "../github/contributions";
import { RepeatedCursorError } from "../github/pages";
import { InstapaperRateLimited, InstapaperResponseError } from "../instapaper/client";
import { RequestCapReached } from "../request-cap";
import { TraktHttpError, TraktRateLimited, TraktValidationError } from "../trakt/client";
import { BudgetRefused } from "./budget";
import { classify } from "./outcome";
import { MissingSecretError } from "./run";

describe("classify", () => {
  it.each([
    { name: "a Trakt 429", error: new TraktRateLimited(60, ""), reason: "rate_limit.upstream" },
    {
      name: "an Instapaper 429",
      error: new InstapaperRateLimited(60, 429, "", null),
      reason: "rate_limit.upstream",
    },
    {
      name: "a GitHub secondary limit",
      error: new SecondaryRateLimited(403, 60, ""),
      reason: "rate_limit.secondary",
    },
    {
      name: "a budget refusal",
      error: new BudgetRefused("floor", "remaining 900", null),
      reason: "rate_limit.budget",
    },
    { name: "a request cap", error: new RequestCapReached(100), reason: "rate_limit.budget" },
    {
      name: "a bare GitHub 429",
      error: new GitHubHttpError(429, ""),
      reason: "rate_limit.upstream",
    },
    {
      name: "a GitHub RATE_LIMITED error",
      error: new GraphQLQueryError([{ message: "limit", type: "RATE_LIMITED" }], "", null),
      reason: "rate_limit.upstream",
    },
  ])("treats $name as a rate limit", ({ error, reason }) => {
    expect(classify(error)).toEqual({ outcome: "rate_limited", reason });
  });

  it.each([
    { name: "a GitHub 502", error: new GitHubHttpError(502, ""), reason: "upstream.5xx" },
    { name: "a GitHub 401", error: new GitHubHttpError(401, ""), reason: "upstream.4xx" },
    { name: "a Trakt 503", error: new TraktHttpError(503, ""), reason: "upstream.5xx" },
    {
      name: "an Instapaper 500",
      error: new InstapaperResponseError("InstapaperApiError", "", 500, ""),
      reason: "upstream.5xx",
    },
    {
      name: "GraphQL errors",
      error: new GraphQLQueryError([{ message: "boom" }], "", null),
      reason: "upstream.graphql",
    },
    {
      name: "a GitHub response that did not validate",
      error: new ResponseValidationError("bad", "", null),
      reason: "upstream.contract",
    },
    {
      name: "a Trakt response that did not validate",
      error: new TraktValidationError("bad", "", null),
      reason: "upstream.contract",
    },
    {
      name: "an Instapaper response that did not validate",
      error: new InstapaperResponseError("InstapaperValidationError", "", 200, ""),
      reason: "upstream.contract",
    },
    {
      name: "a repeated cursor",
      error: new RepeatedCursorError("abc", ""),
      reason: "upstream.contract",
    },
    { name: "a missing secret", error: new MissingSecretError("GITHUB_TOKEN"), reason: "config" },
    { name: "an unknown login", error: new UnknownUserError("nobody", ""), reason: "config" },
    { name: "anything else", error: new Error("D1 is down"), reason: "internal" },
    { name: "a thrown string", error: "nope", reason: "internal" },
  ])("treats $name as a failure", ({ error, reason }) => {
    expect(classify(error)).toEqual({ outcome: "failed", reason });
  });
});
