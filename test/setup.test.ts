import { describe, it, expect, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureSchema } from "./setup";
import {
  createIngestPayload,
  ingestWithRetry,
  formatProgress,
  formatSummary,
  type IngestFetch,
  type SetupSummary,
} from "../src/setup";

describe("createIngestPayload", () => {
  it("creates payload with wiki/ prefix for relative path", () => {
    const payload = createIngestPayload(
      "concepts/Tool Attention.md",
      "## Content",
    );
    expect(payload.file_key).toBe("wiki/concepts/Tool Attention.md");
    expect(payload.file_type).toBe("wiki_page");
    expect(payload.content).toBe("## Content");
    expect(payload.source).toBe("wiki/concepts/Tool Attention.md");
  });

  it("does not double-prefix if path already starts with wiki/", () => {
    const payload = createIngestPayload("wiki/concepts/Test.md", "## Content");
    expect(payload.file_key).toBe("wiki/concepts/Test.md");
  });

  it("extracts title from frontmatter", () => {
    const content = `---
title: My Wiki Page
tags: [concept]
---
## Section
Content here`;
    const payload = createIngestPayload("concepts/page.md", content);
    expect(payload.title).toBe("My Wiki Page");
  });

  it("extracts title from H1 if no frontmatter title", () => {
    const content = `# Page Title\n\nSome content`;
    const payload = createIngestPayload("notes/page.md", content);
    expect(payload.title).toBe("Page Title");
  });

  it("falls back to filename without extension", () => {
    const payload = createIngestPayload(
      "concepts/Tool Attention.md",
      "## Content",
    );
    expect(payload.title).toBe("Tool Attention");
  });

  it("strips quotes from frontmatter title", () => {
    const content = `---
title: "Quoted Title"
---
## Section`;
    const payload = createIngestPayload("page.md", content);
    expect(payload.title).toBe("Quoted Title");
  });
});

describe("ingestWithRetry", () => {
  function makeMockFetch(
    responses: { ok: boolean; status: number; data?: unknown }[],
  ): IngestFetch & { callCount: () => number } {
    let count = 0;
    const fn = async () => {
      const r = responses[Math.min(count, responses.length - 1)];
      count++;
      return {
        ok: r.ok,
        status: r.status,
        json: async () => r.data ?? {},
      };
    };
    return Object.assign(fn, { callCount: () => count });
  }

  it("succeeds on first attempt", async () => {
    const fetchFn = makeMockFetch([
      {
        ok: true,
        status: 200,
        data: { file_key: "wiki/test.md", chunk_count: 3, status: "ok" },
      },
    ]);
    const payload = createIngestPayload("test.md", "## Content");
    const result = await ingestWithRetry(
      fetchFn,
      "http://localhost/api/ingest",
      payload,
      3,
    );
    expect(result.success).toBe(true);
    expect(result.chunk_count).toBe(3);
    expect(result.attempts).toBe(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    const responses = [
      { ok: false, status: 500 },
      { ok: false, status: 502 },
      {
        ok: true,
        status: 200,
        data: { file_key: "wiki/test.md", chunk_count: 1, status: "ok" },
      },
    ];
    const fetchFn = makeMockFetch(responses);
    const payload = createIngestPayload("test.md", "## Content");
    const result = await ingestWithRetry(
      fetchFn,
      "http://localhost/api/ingest",
      payload,
      3,
    );
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("fails after max retries", async () => {
    const fetchFn = makeMockFetch([{ ok: false, status: 500 }]);
    const payload = createIngestPayload("test.md", "## Content");
    const result = await ingestWithRetry(
      fetchFn,
      "http://localhost/api/ingest",
      payload,
      2,
    );
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toBe("HTTP 500");
  });

  it("retries on network error", async () => {
    let calls = 0;
    const fetchFn: IngestFetch = async () => {
      calls++;
      if (calls < 2) throw new Error("Network error");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          file_key: "wiki/test.md",
          chunk_count: 1,
          status: "ok",
        }),
      };
    };
    const payload = createIngestPayload("test.md", "## Content");
    const result = await ingestWithRetry(
      fetchFn,
      "http://localhost/api/ingest",
      payload,
      3,
    );
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

describe("formatProgress", () => {
  it("shows 0% at start", () => {
    const line = formatProgress(0, 100, "concepts/Test.md");
    expect(line).toContain("0%");
    expect(line).toContain("(0/100)");
    expect(line).toContain("concepts/Test.md");
  });

  it("shows 100% at end", () => {
    const line = formatProgress(100, 100, "concepts/Test.md");
    expect(line).toContain("100%");
    expect(line).toContain("(100/100)");
  });

  it("truncates long filenames", () => {
    const longName =
      "concepts/very/long/path/to/a/file/that/exceeds/the/limit.md";
    const line = formatProgress(5, 10, longName);
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(100);
  });

  it("starts with carriage return", () => {
    const line = formatProgress(1, 10, "test.md");
    expect(line.startsWith("\r")).toBe(true);
  });
});

describe("formatSummary", () => {
  it("shows correct counts", () => {
    const summary: SetupSummary = {
      total: 10,
      succeeded: 8,
      failed: 2,
      total_chunks: 42,
      results: [
        {
          file_key: "wiki/fail1.md",
          success: false,
          error: "HTTP 500",
          attempts: 3,
        },
        {
          file_key: "wiki/fail2.md",
          success: false,
          error: "HTTP 502",
          attempts: 3,
        },
      ],
      duration_ms: 5000,
    };
    const output = formatSummary(summary);
    expect(output).toContain("Total files:   10");
    expect(output).toContain("Succeeded:     8");
    expect(output).toContain("Failed:        2");
    expect(output).toContain("Total chunks:  42");
    expect(output).toContain("5.0s");
    expect(output).toContain("wiki/fail1.md");
    expect(output).toContain("wiki/fail2.md");
  });

  it("does not show failed section when all succeed", () => {
    const summary: SetupSummary = {
      total: 5,
      succeeded: 5,
      failed: 0,
      total_chunks: 20,
      results: [],
      duration_ms: 1000,
    };
    const output = formatSummary(summary);
    expect(output).not.toContain("Failed files");
  });
});

describe("Setup integration — ingest via worker", () => {
  it("ingests a file through the worker and verifies health count", async () => {
    await ensureSchema();

    const payload = createIngestPayload(
      "concepts/Setup Integration.md",
      "---\ntitle: Setup Integration\ntags: [test]\n---\n## Section\nContent for integration test.",
    );

    const fetchFn: IngestFetch = async (url, options) => {
      const response = await SELF.fetch(url, {
        method: options.method as "POST",
        headers: options.headers,
        body: options.body,
      });
      return {
        ok: response.ok,
        status: response.status,
        json: () => response.json(),
      };
    };

    const result = await ingestWithRetry(
      fetchFn,
      "http://localhost/api/ingest",
      payload,
      3,
    );

    expect(result.success).toBe(true);
    expect(result.chunk_count).toBeGreaterThan(0);

    const healthResponse = await SELF.fetch("http://localhost/api/health");
    expect(healthResponse.status).toBe(200);
    const health = await healthResponse.json<{
      status: string;
      indexed_files: number;
      total_chunks: number;
    }>();
    expect(health.status).toBe("ok");
    expect(health.indexed_files).toBeGreaterThanOrEqual(1);
  });
});
