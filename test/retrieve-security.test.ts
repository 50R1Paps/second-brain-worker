import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ensureSchema } from "./setup";
import { ingestCore } from "../src/ingest";
import { retrieveCore } from "../src/retrieve";
import type { Env } from "../src/types";

const bindings = env as unknown as Env;

describe("retrieval authority and privacy", () => {
  it("quotes FTS tokens rather than treating query operators as syntax", async () => {
    await ensureSchema();
    await ingestCore(bindings, { file_key: "fts-operators", file_type: "ingested", content: "hello@example.test", push_to_github: false });
    const result = await retrieveCore(bindings, { query: "hello@example OR OR", limit: 10 });
    expect(result.results.some(row => row.file_key === "fts-operators")).toBe(true);
  });

  it("discards stale vectors and enforces every filter before limiting", async () => {
    await ensureSchema();
    await ingestCore(bindings, { file_key: "wiki/a_1.md", file_type: "wiki_page", content: "## Allowed\nkiwifruit", push_to_github: false });
    await ingestCore(bindings, { file_key: "wiki/ax1.md", file_type: "wiki_page", content: "## Allowed\nkiwifruit", push_to_github: false });
    await ingestCore(bindings, { file_key: "other", file_type: "ingested", content: "## Other\nkiwifruit", push_to_github: false });
    await bindings.DB.prepare("UPDATE chunks SET vector_id = CASE file_key WHEN 'wiki/a_1.md' THEN 'active' ELSE 'excluded' END").run();
    const ai = { run: async () => ({ data: [[1, 2, 3]] }) } as unknown as Ai;
    const vectors = { query: async () => ({ matches: [
      { id: "stale", score: 0.99 }, { id: "excluded", score: 0.98 }, { id: "active", score: 0.8 },
    ] }) } as unknown as VectorizeIndex;
    const result = await retrieveCore({ ...bindings, AI: ai, VECTORIZE: vectors }, {
      query: "kiwifruit", limit: 1, filter: { file_type: "wiki_page", section_prefix: "## Allowed", file_key_prefix: "wiki/a_" },
    });
    expect(result.results.map(r => r.file_key)).toEqual(["wiki/a_1.md"]);
    const metric = await bindings.DB.prepare("SELECT query FROM retrieve_metrics ORDER BY id DESC LIMIT 1").first<{ query: string }>();
    expect(metric?.query).toBe("");
  });
});
