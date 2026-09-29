import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("applies the migrations in migrations/", async () => {
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind("sync_state")
    .first<{ name: string }>();

  expect(table).toEqual({ name: "sync_state" });
});
