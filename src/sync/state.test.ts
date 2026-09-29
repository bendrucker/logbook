import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { advance, readWatermark, readWatermarks } from "./state";

describe("advance", () => {
  it("records the window and when it moved", async () => {
    await advance(env.DB, "pr-authored", "2026-09-01..2026-09-08", "2026-09-09T18:00:00Z");

    expect(await readWatermark(env.DB, "pr-authored")).toEqual({
      window: "2026-09-01..2026-09-08",
      updatedAt: "2026-09-09T18:00:00Z",
    });
  });

  it("moves a watermark that is already set", async () => {
    await advance(env.DB, "issue", "2026-09-01..2026-09-08", "2026-09-09T18:00:00Z");
    await advance(env.DB, "issue", "2026-09-08..2026-09-15", "2026-09-16T18:00:00Z");

    expect(await readWatermark(env.DB, "issue")).toEqual({
      window: "2026-09-08..2026-09-15",
      updatedAt: "2026-09-16T18:00:00Z",
    });
  });

  it("refuses to rewind, so a backfill cannot undo a caught-up kind", async () => {
    await advance(env.DB, "pr-authored", "2026-09-09T12:00:00.000Z", "2026-09-09T12:00:00Z");
    await advance(env.DB, "pr-authored", "2013-04-30T23:59:59.999Z", "2026-09-09T18:00:00Z");

    expect(await readWatermark(env.DB, "pr-authored")).toEqual({
      window: "2026-09-09T12:00:00.000Z",
      updatedAt: "2026-09-09T12:00:00Z",
    });
  });

  it("leaves the other kinds where they were", async () => {
    await advance(env.DB, "contributions", "2026", "2026-09-09T18:00:00Z");

    expect(await readWatermark(env.DB, "pr-reviewed")).toBeNull();
  });
});

describe("readWatermarks", () => {
  it("answers for every kind, set or not", async () => {
    await advance(env.DB, "pr-reviewed", "2026-09-01..2026-09-08", "2026-09-09T18:00:00Z");

    expect(await readWatermarks(env.DB)).toEqual({
      "pr-authored": null,
      "pr-reviewed": { window: "2026-09-01..2026-09-08", updatedAt: "2026-09-09T18:00:00Z" },
      issue: null,
      contributions: null,
      "issue-contributions": null,
      "pr-contributions": null,
      "review-contributions": null,
      "instapaper-bookmarks": null,
      "instapaper-highlights": null,
    });
  });

  it("reads nothing a sync has not written", async () => {
    await env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)")
      .bind("cursor:lake", "github/2026", "2026-09-09T18:00:00Z")
      .run();

    const watermarks = await readWatermarks(env.DB);

    expect(Object.values(watermarks).every((watermark) => watermark === null)).toBe(true);
  });
});
