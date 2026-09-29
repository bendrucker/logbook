import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { emptyTables } from "./tables";

// The pool shares one database across every test in a file, so a test would
// otherwise read whatever its predecessors wrote.
beforeEach(async () => {
  await emptyTables(env.DB);
});
