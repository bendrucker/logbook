import { createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../test/fetch-stub";
import {
  contributionsPayload,
  jsonResponse,
  requestBody,
  searchPayload,
} from "../test/github-fixtures";
import { emptyBucket } from "../test/r2";
import { failingOn } from "../test/tables";
import worker from "./index";
import { recentInvocations } from "./invocations";
import { LAKE_CRON, readLatestBuild } from "./lake";
import { recentRuns } from "./sync/runs";
import { advance, readWatermark } from "./sync/state";
import { moviePlay, traktResponse } from "../test/trakt-fixtures";

describe("fetch", () => {
  it("reports health", async () => {
    const response = await exports.default.fetch("https://logbook.test/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not answer health on a write method", async () => {
    const response = await exports.default.fetch("https://logbook.test/healthz", {
      method: "POST",
    });

    expect(response.status).toBe(404);
  });

  it("404s an unknown path", async () => {
    const response = await exports.default.fetch("https://logbook.test/");

    expect(response.status).toBe(404);
  });
});

describe("scheduled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete env.GITHUB_TOKEN;
  });

  it("runs the incremental sync on the cron", async () => {
    env.GITHUB_TOKEN = "token";
    await advance(env.DB, "issue", "2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00Z");
    const { fetch, requests } = stubFetch(async (request) => {
      const { variables } = await requestBody(request.clone());
      return variables.searchQuery === undefined
        ? jsonResponse(contributionsPayload(0))
        : jsonResponse(searchPayload([]));
    });
    vi.stubGlobal("fetch", fetch);

    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), env);

    expect(toGitHub(requests)).toHaveLength(2);
    expect(await recentRuns(env.DB, "issue", 1)).toMatchObject([{ pages: 1, error: null }]);
    expect(await recentRuns(env.DB, "contributions", 1)).toMatchObject([{ error: null }]);
  });

  it("records the invocation and samples freshness after a failed run", async () => {
    env.GITHUB_TOKEN = "token";
    await advance(env.DB, "issue", "2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00Z");
    const { fetch } = stubFetch((request) =>
      new URL(request.url).hostname === "api.github.com"
        ? new Response("unavailable", { status: 503 })
        : traktResponse([], null),
    );
    vi.stubGlobal("fetch", fetch);

    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), env);

    expect(await recentRuns(env.DB, "issue", 1)).toMatchObject([{ outcome: "failed" }]);
    const [invocation] = await recentInvocations(env.DB, 1);
    expect(invocation).toMatchObject({ cron: "17 * * * *", error: null });
    expect(invocation?.finishedAt).not.toBeNull();
    const { results } = await env.DB.prepare("SELECT kind FROM sli_samples ORDER BY kind").all();
    expect(results).toEqual([{ kind: "issue" }, { kind: "lake" }, { kind: "trakt-ratings" }]);
  });

  it("does not fail a clean invocation when the freshness sample fails", async () => {
    const { fetch } = stubFetch(() => traktResponse([], null));
    vi.stubGlobal("fetch", fetch);

    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), {
      ...env,
      DB: failingOn(env.DB, "sli_samples"),
    });

    const [invocation] = await recentInvocations(env.DB, 1);
    expect(invocation).toMatchObject({ error: null });
    expect(invocation?.finishedAt).not.toBeNull();
  });

  it("syncs Trakt beside GitHub on the same cron", async () => {
    const { fetch, requests } = stubFetch(() => traktResponse([], null));
    vi.stubGlobal("fetch", fetch);

    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), env);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/users/bendrucker/ratings",
    ]);
    expect(await recentRuns(env.DB, "trakt-ratings", 1)).toMatchObject([{ error: null }]);
  });

  it("records a skip rather than a run while the GitHub token is unset", async () => {
    await advance(env.DB, "issue", "2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00Z");

    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), env);

    expect(await recentRuns(env.DB, "issue", 2)).toMatchObject([
      { outcome: "skipped", reason: "skip.missing_secret", pages: 0 },
    ]);
  });
});

describe("the nightly lake cron", () => {
  beforeEach(() => emptyBucket(env.LAKE));

  afterEach(() => {
    vi.unstubAllGlobals();
    delete env.GITHUB_TOKEN;
  });

  it("is one the deployment triggers", () => {
    expect(env.TEST_CRONS).toContain(LAKE_CRON);
  });

  it("builds the lake instead of syncing", async () => {
    env.GITHUB_TOKEN = "token";
    await advance(env.DB, "issue", "2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00Z");
    const { fetch, requests } = stubFetch(() => {
      throw new Error("the lake build reads D1, not GitHub");
    });
    vi.stubGlobal("fetch", fetch);

    await worker.scheduled(createScheduledController({ cron: LAKE_CRON }), env);

    expect(toGitHub(requests)).toEqual([]);
    expect(await recentInvocations(env.DB, 1)).toMatchObject([{ cron: LAKE_CRON, error: null }]);
    // `buildLake` finishes the row only once every table is in R2, so a build
    // that carries counts and no error is one that wrote.
    expect(await readLatestBuild(env.DB)).toMatchObject({
      error: null,
      rowCounts: { repositories: 0 },
    });
  });

  it("re-reads the current year of Trakt history before building", async () => {
    const { fetch, requests } = stubFetch(() =>
      traktResponse([moviePlay(1, "2026-02-01T20:00:00.000Z")]),
    );
    vi.stubGlobal("fetch", fetch);

    await worker.scheduled(createScheduledController({ cron: LAKE_CRON }), env);

    expect(requests.map((request) => new URL(request.url).searchParams.get("start_at"))).toEqual([
      `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`,
    ]);
    expect(await readWatermark(env.DB, "trakt-history")).toBeNull();
    expect(await readLatestBuild(env.DB)).toMatchObject({
      error: null,
      rowCounts: { trakt_plays: 1 },
    });
  });
});

// Trakt runs on the same crons, so a GitHub assertion counts GitHub's requests.
function toGitHub(requests: readonly Request[]): Request[] {
  return requests.filter((request) => new URL(request.url).hostname === "api.github.com");
}
