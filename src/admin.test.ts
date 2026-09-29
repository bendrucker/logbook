import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { pullRequest, seedRepository } from "../test/fixtures";
import { emptyBucket } from "../test/r2";
import { upsertPullRequests } from "./store";
import { enqueue } from "./sync/frontier";
import { advance } from "./sync/state";
import { finishRun, startRun } from "./sync/runs";

const token = "admin-token";

function get(headers: HeadersInit = {}): Promise<Response> {
  return exports.default.fetch("https://logbook.test/admin/sync", { headers });
}

function post(query: string, headers: HeadersInit = {}): Promise<Response> {
  return exports.default.fetch(`https://logbook.test/admin/backfill?${query}`, {
    method: "POST",
    headers,
  });
}

function postLake(headers: HeadersInit = {}): Promise<Response> {
  return exports.default.fetch("https://logbook.test/admin/lake", { method: "POST", headers });
}

const authorization = { Authorization: `Bearer ${token}` };

beforeEach(() => {
  env.ADMIN_TOKEN = token;
  env.GITHUB_TOKEN = "github-token";
});

afterEach(() => {
  delete env.ADMIN_TOKEN;
  delete env.GITHUB_TOKEN;
});

describe("GET /admin/sync", () => {
  it("does not exist until the token is configured", async () => {
    delete env.ADMIN_TOKEN;

    expect((await get({ Authorization: `Bearer ${token}` })).status).toBe(404);
  });

  test.each<{ name: string; headers: HeadersInit }>([
    { name: "no Authorization header", headers: {} },
    { name: "a token that is not the configured one", headers: { Authorization: "Bearer wrong" } },
    { name: "the right token under no scheme", headers: { Authorization: token } },
    {
      name: "the right token under the wrong scheme",
      headers: { Authorization: `Basic ${token}` },
    },
    { name: "an empty bearer", headers: { Authorization: "Bearer " } },
  ])("rejects $name", async ({ headers }) => {
    expect((await get(headers)).status).toBe(401);
  });

  it("reports the watermark, the last run, and recent failures", async () => {
    await advance(env.DB, "pr-authored", "2026-09-01..2026-09-08", "2026-09-09T18:00:00Z");
    const id = await startRun(
      env.DB,
      "pr-authored",
      "2026-09-08..2026-09-15",
      "2026-09-09T18:02:00Z",
    );
    await finishRun(
      env.DB,
      id,
      {
        pages: 2,
        rowsChanged: 9,
        truncated: true,
        error: "502 from search",
        note: null,
        cost: 2,
        rateRemaining: 4100,
      },
      "2026-09-09T18:03:00Z",
    );

    const response = await get({ Authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({
      kinds: {
        "pr-authored": {
          watermark: { window: "2026-09-01..2026-09-08", updatedAt: "2026-09-09T18:00:00Z" },
          lastRun: {
            id,
            kind: "pr-authored",
            window: "2026-09-08..2026-09-15",
            startedAt: "2026-09-09T18:02:00Z",
            finishedAt: "2026-09-09T18:03:00Z",
            pages: 2,
            rowsChanged: 9,
            truncated: true,
            error: "502 from search",
          },
        },
        "pr-reviewed": { watermark: null, lastRun: null },
        issue: { watermark: null, lastRun: null },
        contributions: { watermark: null, lastRun: null },
        "issue-contributions": { watermark: null, lastRun: null },
        "pr-contributions": { watermark: null, lastRun: null },
        "review-contributions": { watermark: null, lastRun: null },
      },
      failures: [{ id, error: "502 from search" }],
    });
  });

  it("reports what the backfill frontier still holds per kind", async () => {
    await enqueue(env.DB, "issue", ["2014-01", "2014-02"]);
    await enqueue(env.DB, "contributions", ["2015-07-14T03--2015-07-14T04"]);
    await env.DB.prepare("UPDATE crawl_units SET status = 'irreducible' WHERE kind = ?")
      .bind("contributions")
      .run();

    const response = await get(authorization);

    expect(await response.json()).toMatchObject({
      kinds: {
        "pr-authored": { frontier: { pending: 0, irreducible: [] } },
        issue: { frontier: { pending: 2, irreducible: [] } },
        contributions: {
          frontier: { pending: 0, irreducible: ["2015-07-14T03--2015-07-14T04"] },
        },
      },
    });
  });

  it("still reports when the table holds a kind this build does not know", async () => {
    // The migration leaves `kind` unconstrained so a rename does not fail at
    // ingest. Reading has to hold up its end of that.
    await env.DB.prepare(
      "INSERT INTO sync_runs (kind, window, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("pr-drafted", "2026-08", "2026-09-08T18:00:00Z", "2026-09-08T18:01:00Z", "retired kind")
      .run();

    const response = await get({ Authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      failures: [{ kind: "pr-drafted", error: "retired kind" }],
    });
  });

  it("reports no lake build before the first one runs", async () => {
    await expect((await get(authorization)).json()).resolves.toMatchObject({ lake: null });
  });

  it("reports the last lake build", async () => {
    await emptyBucket(env.LAKE);
    await seedRepository(env.DB);
    await postLake(authorization);

    const response = await get(authorization);

    await expect(response.json()).resolves.toMatchObject({
      lake: { rowCounts: { repositories: 1 }, error: null },
    });
  });
});

describe("POST /admin/lake", () => {
  beforeEach(() => emptyBucket(env.LAKE));

  it("does not exist until the token is configured", async () => {
    delete env.ADMIN_TOKEN;

    expect((await postLake(authorization)).status).toBe(404);
  });

  it("rejects a request without the token", async () => {
    expect((await postLake()).status).toBe(401);
  });

  it("reports what each table counted", async () => {
    await seedRepository(env.DB);
    await upsertPullRequests(env.DB, [pullRequest()]);

    const response = await postLake(authorization);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rowCounts: { repositories: 1, pull_requests: 1, reviews: 0, issues: 0, commit_days: 0 },
    });
  });

  it("answers 500 with the reason a table could not encode", async () => {
    await seedRepository(env.DB);
    await env.DB.prepare("UPDATE repositories SET is_fork = 2").run();

    const response = await postLake(authorization);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- vitest types asymmetric matchers as `any`
      error: expect.stringContaining("is_fork"),
    });
  });
});

describe("POST /admin/backfill", () => {
  it("does not exist until the token is configured", async () => {
    delete env.ADMIN_TOKEN;

    expect((await post("kind=issue", authorization)).status).toBe(404);
  });

  it("rejects a request without the token", async () => {
    expect((await post("kind=issue")).status).toBe(401);
  });

  test.each<{ name: string; query: string }>([
    { name: "no kind", query: "from=2012-12" },
    { name: "a kind no sync writes", query: "kind=pr-drafted&from=2012-12" },
    { name: "a from that is not a month", query: "kind=issue&from=2012" },
  ])("answers 400 on $name", async ({ query }) => {
    expect((await post(query, authorization)).status).toBe(400);
  });

  it("answers 503 while the GitHub token is unset", async () => {
    delete env.GITHUB_TOKEN;

    const response = await post("kind=issue&from=2099-01", authorization);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "GITHUB_TOKEN is not configured" });
  });

  it("walks nothing and leaves nothing pending once the window is in the future", async () => {
    const response = await post("kind=issue&from=2099-01", authorization);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      kind: "issue",
      windows: [],
      pages: 0,
      rowsChanged: 0,
      pending: 0,
      irreducible: [],
      resumeAt: null,
      error: null,
    });
  });
});
