import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
});
