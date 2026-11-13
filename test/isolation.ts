import { reset } from "cloudflare:test";
import { beforeEach } from "vitest";
import { ensureSchema } from "./setup";

// Vitest 4 isolates Workers storage per file, not per test.
beforeEach(async () => {
  await reset();
  await ensureSchema();
});
