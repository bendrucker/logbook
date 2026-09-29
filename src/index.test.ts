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
import worker from "./index";
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
    delete env.TRAKT_CLIENT_ID;
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

    await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env);

    expect(requests).toHaveLength(2);
    expect(await recentRuns(env.DB, "issue", 1)).toMatchObject([{ pages: 1, error: null }]);
    expect(await recentRuns(env.DB, "contributions", 1)).toMatchObject([{ error: null }]);
  });

  it("syncs Trakt beside GitHub on the same cron", async () => {
    env.TRAKT_CLIENT_ID = "client-id";
    const { fetch, requests } = stubFetch(() => traktResponse([], null));
    vi.stubGlobal("fetch", fetch);

    await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/users/bendrucker/ratings",
    ]);
    expect(await recentRuns(env.DB, "trakt-ratings", 1)).toMatchObject([{ error: null }]);
  });

  it("writes no run while the GitHub token is unset", async () => {
    await advance(env.DB, "issue", "2026-09-09T10:00:00.000Z", "2026-09-09T10:00:00Z");

    await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env);

    expect(await recentRuns(env.DB, "issue", 1)).toEqual([]);
  });
});

describe("the nightly lake cron", () => {
  beforeEach(() => emptyBucket(env.LAKE));

  afterEach(() => {
    vi.unstubAllGlobals();
    delete env.GITHUB_TOKEN;
    delete env.TRAKT_CLIENT_ID;
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

    expect(requests).toEqual([]);
    // `buildLake` finishes the row only once every table is in R2, so a build
    // that carries counts and no error is one that wrote.
    expect(await readLatestBuild(env.DB)).toMatchObject({
      error: null,
      rowCounts: { repositories: 0 },
    });
  });

  it("re-reads the current year of Trakt history before building", async () => {
    env.TRAKT_CLIENT_ID = "client-id";
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
