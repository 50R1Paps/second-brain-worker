import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./test/wrangler.test.toml" },
    remoteBindings: false,
    // Never inject the local production REST credential into isolated tests.
    miniflare: { bindings: { API_TOKEN: "test-api-token" } },
  })],
  test: {
    // Cold workerd/RPC startup on Windows exceeds Vitest's 5s unit-test default.
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["./test/isolation.ts"],
    provide: { migrations: await readD1Migrations("./migrations") },
  },
}));
