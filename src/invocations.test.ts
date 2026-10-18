import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { failingOn } from "../test/tables";
import { recentInvocations, recordInvocation } from "./invocations";

describe("recordInvocation", () => {
  it("finishes the row with no error when the body succeeds", async () => {
    await recordInvocation(env.DB, "0 * * * *", () => Promise.resolve());

    const [invocation] = await recentInvocations(env.DB, 10);
    expect(invocation).toMatchObject({ cron: "0 * * * *", error: null });
    expect(invocation?.finishedAt).not.toBeNull();
  });

  it("records the error and rethrows it when the body fails", async () => {
    const failure = new TypeError("lake write refused");

    await expect(
      recordInvocation(env.DB, "30 9 * * *", () => Promise.reject(failure)),
    ).rejects.toBe(failure);

    const [invocation] = await recentInvocations(env.DB, 10);
    expect(invocation).toMatchObject({
      cron: "30 9 * * *",
      error: "TypeError: lake write refused",
    });
    expect(invocation?.finishedAt).not.toBeNull();
  });

  it("shows the invocation as unfinished while the body runs", async () => {
    let during: Awaited<ReturnType<typeof recentInvocations>> = [];

    await recordInvocation(env.DB, "0 * * * *", async () => {
      during = await recentInvocations(env.DB, 10);
    });

    expect(during).toMatchObject([{ finishedAt: null, error: null }]);
  });

  it("runs the body when the row cannot be written", async () => {
    let ran = false;

    await recordInvocation(failingOn(env.DB, "invocations"), "0 * * * *", () => {
      ran = true;
      return Promise.resolve();
    });

    expect(ran).toBe(true);
  });

  it("keeps the body's error when the row cannot be finished", async () => {
    const failure = new TypeError("lake write refused");
    const db = failingOn(env.DB, "UPDATE invocations");

    await expect(recordInvocation(db, "30 9 * * *", () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });

  it("does not fail a clean body when the row cannot be finished", async () => {
    await expect(
      recordInvocation(failingOn(env.DB, "UPDATE invocations"), "0 * * * *", () =>
        Promise.resolve(),
      ),
    ).resolves.toBeUndefined();
  });
});
