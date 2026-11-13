import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runMaintenance } from "../src/cron";
import type { Env } from "../src/types";

// Bindings come from the isolated Wrangler configuration.
const bindings = env as Env;

describe("scheduled data retention", () => {
  it("redacts retained search text and expires old metrics and ingress records", async () => {
    await bindings.DB.batch([
      bindings.DB.prepare(`INSERT INTO retrieve_metrics
        (query, latency_ms, result_count, total_candidates, zero_results,
         semantic_hits, keyword_hits, semantic_returned, keyword_returned, hybrid_returned, created_at)
        VALUES ('private search', 1, 0, 0, 1, 0, 0, 0, 0, 0, datetime('now', '-31 days')),
               ('private search', 1, 0, 0, 1, 0, 0, 0, 0, 0, datetime('now'))`),
      bindings.DB.prepare("INSERT INTO request_counters VALUES ('expired', 1, 0), ('active', 1, 4102444800)"),
      bindings.DB.prepare("INSERT INTO webhook_receipts VALUES ('expired', 'done', 0, 0), ('active', 'done', 0, 4102444800)"),
    ]);

    await runMaintenance(bindings);

    expect((await bindings.DB.prepare("SELECT query FROM retrieve_metrics").all()).results).toEqual([{ query: "" }]);
    expect((await bindings.DB.prepare("SELECT bucket FROM request_counters").all()).results).toEqual([{ bucket: "active" }]);
    expect((await bindings.DB.prepare("SELECT digest FROM webhook_receipts").all()).results).toEqual([{ digest: "active" }]);
  });

  it("cleans more than 100 expired raw objects without deleting retained objects", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredKeys = Array.from({ length: 105 }, (_, index) => `raw/expired-${index}`);
    await Promise.all(expiredKeys.map(key => bindings.RAW_BUCKET.put(key, "obsolete")));
    await bindings.RAW_BUCKET.put("raw/recent", "still retained");
    await bindings.DB.batch([
      ...expiredKeys.map(key => bindings.DB.prepare("INSERT INTO storage_gc VALUES ('raw', ?, ?)").bind(key, now - 1)),
      bindings.DB.prepare("INSERT INTO storage_gc VALUES ('raw', ?, ?)").bind("raw/recent", now + 86400),
    ]);
    await runMaintenance(bindings);

    expect((await bindings.RAW_BUCKET.list()).objects.map(object => object.key)).toEqual(["raw/recent"]);
    expect(await (await bindings.RAW_BUCKET.get("raw/recent"))?.text()).toBe("still retained");
    expect((await bindings.DB.prepare("SELECT storage_key FROM storage_gc").all()).results)
      .toEqual([{ storage_key: "raw/recent" }]);
  });
});
