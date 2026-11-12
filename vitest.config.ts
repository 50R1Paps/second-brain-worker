import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.toml" },
        // Local .dev.vars must not override the isolated test credential.
        miniflare: { bindings: { API_TOKEN: "test-api-token" } },
      },
    },
  },
});
