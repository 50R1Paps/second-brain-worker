import { env, SELF, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { inject } from "vitest";
import type { Env } from "../src/types";

// The runner supplies wrangler.test.toml bindings; its ambient Env is ungenerated.
const bindings = env as Env;

// Use the production migrations, rather than maintaining a second schema.
declare module "vitest" {
  export interface ProvidedContext {
    migrations: D1Migration[];
  }
}

export async function ensureSchema(): Promise<void> {
  await applyD1Migrations(bindings.DB, inject("migrations"));
}

export const TEST_API_TOKEN = "test-api-token";

/** SELF.fetch with the isolated REST API bearer token. */
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TEST_API_TOKEN}`);
  return SELF.fetch(url, { ...init, headers });
}
