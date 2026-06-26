import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureSchema } from "./setup";

const MARKDOWN_ARCHITECTURE = `---
title: Architecture Page
tags: [architecture]
---
## Architecture Overview
The system uses a serverless architecture on Cloudflare Workers with D1 database and R2 storage.

## Architecture Details
The worker handles routing, chunking, and vector embedding generation for semantic search.
Wikilinks like [[Tool Attention]] are preserved during chunking.`;

const MARKDOWN_TESTING = `---
title: Testing Page
tags: [testing]
---
## Testing Strategy
We use vitest for unit testing and integration testing of the worker endpoints.

## Test Coverage
The test suite covers health checks, ingestion, and retrieval endpoints.`;

async function ingestFile(
  file_key: string,
  content: string,
  file_type: "wiki_page" | "ingested" = "wiki_page",
  title?: string,
) {
  await SELF.fetch("http://localhost/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_key,
      content,
      file_type,
      title,
      push_to_github: false,
    }),
  });
}

interface RetrieveResult {
  file_key: string;
  title: string | null;
  chunk_index: number;
  section: string | null;
  content: string;
  wikilinks: string[];
  score: number;
  search_type: string;
}

interface RetrieveResponse {
  query: string;
  results: RetrieveResult[];
  total: number;
}

describe("POST /api/retrieve — validation", () => {
  it("rejects missing query", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects empty query", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects invalid JSON body", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/retrieve — keyword search", () => {
  it("returns results for a matching query", async () => {
    await ensureSchema();
    await ingestFile(
      "wiki/retrieve-arch.md",
      MARKDOWN_ARCHITECTURE,
      "wiki_page",
      "Architecture Page",
    );

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "serverless architecture" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();

    expect(data.query).toBe("serverless architecture");
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.length).toBeLessThanOrEqual(10);

    const result = data.results[0];
    expect(result.file_key).toBe("wiki/retrieve-arch.md");
    expect(result.title).toBe("Architecture Page");
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.search_type).toBe("keyword");
    expect(result.content).toContain("serverless");
  });

  it("respects limit parameter", async () => {
    await ensureSchema();
    await ingestFile("wiki/retrieve-limit-1.md", MARKDOWN_ARCHITECTURE);
    await ingestFile("wiki/retrieve-limit-2.md", MARKDOWN_ARCHITECTURE);

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "architecture", limit: 1 }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();
    expect(data.results.length).toBe(1);
  });

  it("returns results sorted by score descending", async () => {
    await ensureSchema();
    await ingestFile("wiki/retrieve-sort-1.md", MARKDOWN_ARCHITECTURE);
    await ingestFile("wiki/retrieve-sort-2.md", MARKDOWN_TESTING);

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "architecture" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();
    for (let i = 1; i < data.results.length; i++) {
      expect(data.results[i].score).toBeLessThanOrEqual(
        data.results[i - 1].score,
      );
    }
  });

  it("includes metadata in results", async () => {
    await ensureSchema();
    await ingestFile(
      "wiki/retrieve-meta.md",
      MARKDOWN_ARCHITECTURE,
      "wiki_page",
      "Meta Test",
    );

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "serverless" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();
    const result = data.results.find(
      (r) => r.file_key === "wiki/retrieve-meta.md",
    );
    expect(result).toBeDefined();
    expect(result!.title).toBe("Meta Test");
    expect(result!.section).toContain("##");
    expect(result!.chunk_index).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result!.wikilinks)).toBe(true);
  });
});

describe("POST /api/retrieve — filters", () => {
  it("filters by file_type", async () => {
    await ensureSchema();
    await ingestFile(
      "wiki/retrieve-filter-wiki.md",
      MARKDOWN_ARCHITECTURE,
      "wiki_page",
    );
    await ingestFile(
      "retrieve-filter-ingested",
      MARKDOWN_ARCHITECTURE,
      "ingested",
    );

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "serverless architecture",
        filter: { file_type: "wiki_page" },
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.file_key).toBe("wiki/retrieve-filter-wiki.md");
    }
  });

  it("filters by section_prefix", async () => {
    await ensureSchema();
    await ingestFile("wiki/retrieve-section.md", MARKDOWN_ARCHITECTURE);

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "architecture",
        filter: { section_prefix: "## Architecture Details" },
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.section).toMatch(/^## Architecture Details/);
    }
  });

  it("filters by file_key_prefix", async () => {
    await ensureSchema();
    await ingestFile("wiki/concepts/retrieve-prefix.md", MARKDOWN_ARCHITECTURE);
    await ingestFile("wiki/other/retrieve-other.md", MARKDOWN_ARCHITECTURE);

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "architecture",
        filter: { file_key_prefix: "wiki/concepts/" },
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();
    expect(data.results.length).toBeGreaterThan(0);
    for (const result of data.results) {
      expect(result.file_key).toMatch(/^wiki\/concepts\//);
    }
  });
});

describe("POST /api/retrieve — content truncation", () => {
  it("truncates content to 2000 characters", async () => {
    await ensureSchema();
    const { env } = await import("cloudflare:test");
    const db = (env as unknown as { DB: D1Database }).DB;
    const now = new Date().toISOString();

    await db.batch([
      db
        .prepare(
          `INSERT INTO files (file_key, file_type, r2_key, title, source, created_at, updated_at, chunk_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "wiki/truncate-test.md",
          "wiki_page",
          "wiki/truncate-test.md",
          null,
          null,
          now,
          now,
          1,
        ),
      db
        .prepare(
          `INSERT INTO chunks (file_key, chunk_index, content, section, wikilinks, vector_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "wiki/truncate-test.md",
          0,
          `truncate ${"A".repeat(3000)}`,
          "## Truncate",
          "[]",
          null,
        ),
    ]);

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "truncate" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();
    const result = data.results.find(
      (r) => r.file_key === "wiki/truncate-test.md",
    );
    expect(result).toBeDefined();
    expect(result!.content.length).toBeLessThanOrEqual(2000);
  });
});

describe("POST /api/retrieve — edge cases", () => {
  it("returns empty results for non-matching query", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "zzzznonexistentzzzz" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<RetrieveResponse>();
    expect(data.results.length).toBe(0);
    expect(data.total).toBe(0);
  });

  it("returns 404 for wrong method on /api/retrieve", async () => {
    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "GET",
    });
    expect(response.status).toBe(404);
  });
});
