import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureSchema } from "./setup";

const SAMPLE_MARKDOWN = `---
title: MCP Test Page
tags: [test]
---
## Introduction
This is a test page about [[Tool Attention]] and related concepts.

## Details
The system uses markdown chunking with overlap to preserve context.
It should not split [[Wikilinks]] across chunk boundaries.`;

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

describe("MCP — REST API still works through OAuthProvider", () => {
  it("GET /api/health returns ok", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/health");
    expect(response.status).toBe(200);
    const data = await response.json<{
      status: string;
      version: string;
    }>();
    expect(data.status).toBe("ok");
    expect(data.version).toBe("1.0.0");
  });

  it("POST /api/ingest works through new routing", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/mcp-test.md",
        content: SAMPLE_MARKDOWN,
        file_type: "wiki_page",
        title: "MCP Test Page",
        push_to_github: false,
      }),
    });
    expect(response.status).toBe(200);
    const data = await response.json<{
      file_key: string;
      chunk_count: number;
      status: string;
    }>();
    expect(data.file_key).toBe("wiki/mcp-test.md");
    expect(data.chunk_count).toBeGreaterThan(0);
    expect(data.status).toBe("ok");
  });

  it("POST /api/retrieve works through new routing", async () => {
    await ensureSchema();
    await ingestFile(
      "wiki/mcp-retrieve.md",
      SAMPLE_MARKDOWN,
      "wiki_page",
      "MCP Retrieve Test",
    );

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "markdown chunking" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<{
      query: string;
      results: Array<{ file_key: string; content: string }>;
      total: number;
    }>();
    expect(data.query).toBe("markdown chunking");
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].content).toContain("markdown");
  });
});

describe("MCP — reindex endpoint", () => {
  it("POST /api/reindex reindexes a single file", async () => {
    await ensureSchema();
    await ingestFile("wiki/mcp-reindex.md", "## Original\nFirst content");

    const response = await SELF.fetch("http://localhost/api/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_key: "wiki/mcp-reindex.md" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<{
      file_key: string;
      reindexed: number;
      status: string;
    }>();
    expect(data.file_key).toBe("wiki/mcp-reindex.md");
    expect(data.reindexed).toBe(1);
    expect(data.status).toBe("ok");
  });

  it("POST /api/reindex returns 404 for unknown file", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_key: "wiki/nonexistent.md" }),
    });

    expect(response.status).toBe(404);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("POST /api/reindex reindexes all files when no file_key", async () => {
    await ensureSchema();
    await ingestFile("wiki/mcp-reindex-all-1.md", "## File 1\nContent 1");
    await ingestFile("wiki/mcp-reindex-all-2.md", "## File 2\nContent 2");

    const response = await SELF.fetch("http://localhost/api/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const data = await response.json<{
      file_key: string | null;
      reindexed: number;
      status: string;
    }>();
    expect(data.file_key).toBeNull();
    expect(data.reindexed).toBeGreaterThanOrEqual(2);
    expect(data.status).toBe("ok");
  });
});

describe("MCP — /mcp endpoint exists", () => {
  it("responds to /mcp path (not 404)", async () => {
    const response = await SELF.fetch("http://localhost/mcp", {
      method: "GET",
    });
    expect(response.status).not.toBe(404);
  });
});

describe("MCP — read endpoint", () => {
  it("POST /api/read returns raw text for an indexed file", async () => {
    await ensureSchema();
    const content =
      "## Section A\nThis is the first section.\n\n## Section B\nThis is the second section with [[Wikilink]].";
    await ingestFile("wiki/mcp-read-test.md", content);

    const response = await SELF.fetch("http://localhost/api/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_key: "wiki/mcp-read-test.md" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<{
      file_key: string;
      content: string;
      offset: number;
      total_length: number;
      truncated: boolean;
    }>();
    expect(data.file_key).toBe("wiki/mcp-read-test.md");
    expect(data.offset).toBe(0);
    expect(data.content).toContain("Section A");
    expect(data.content).toContain("Section B");
    expect(data.truncated).toBe(false);
  });

  it("POST /api/read respects offset and max_chars", async () => {
    await ensureSchema();
    const content = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    await ingestFile("wiki/mcp-read-offset.md", content);

    const response = await SELF.fetch("http://localhost/api/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/mcp-read-offset.md",
        offset: 10,
        max_chars: 5,
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<{
      content: string;
      offset: number;
      total_length: number;
      truncated: boolean;
    }>();
    expect(data.offset).toBe(10);
    expect(data.content).toBe("KLMNO");
    expect(data.truncated).toBe(true);
  });

  it("POST /api/read returns 404 for unknown file", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_key: "wiki/nonexistent.md" }),
    });

    expect(response.status).toBe(404);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("NOT_FOUND");
  });
});

describe("MCP — grep endpoint", () => {
  it("POST /api/grep finds regex matches with context", async () => {
    await ensureSchema();
    const content =
      "The total is $42.50 and the date is 2024-01-15. Another total is $100.00.";
    await ingestFile("wiki/mcp-grep-test.md", content);

    const response = await SELF.fetch("http://localhost/api/grep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/mcp-grep-test.md",
        pattern: "\\$[0-9]+\\.[0-9]+",
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<{
      file_key: string;
      pattern: string;
      matches: Array<{
        match: string;
        start: number;
        end: number;
        context: { text: string };
      }>;
      total: number;
    }>();
    expect(data.file_key).toBe("wiki/mcp-grep-test.md");
    expect(data.total).toBe(2);
    expect(data.matches[0].match).toBe("$42.50");
    expect(data.matches[1].match).toBe("$100.00");
    expect(data.matches[0].context.text).toContain("total is $42.50");
  });

  it("POST /api/grep respects max_matches limit", async () => {
    await ensureSchema();
    const content = "aaa bbb aaa bbb aaa bbb aaa bbb";
    await ingestFile("wiki/mcp-grep-limit.md", content);

    const response = await SELF.fetch("http://localhost/api/grep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/mcp-grep-limit.md",
        pattern: "aaa",
        max_matches: 2,
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<{ total: number }>();
    expect(data.total).toBe(2);
  });

  it("POST /api/grep returns no matches for non-matching pattern", async () => {
    await ensureSchema();
    await ingestFile("wiki/mcp-grep-nomatch.md", "Hello world");

    const response = await SELF.fetch("http://localhost/api/grep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/mcp-grep-nomatch.md",
        pattern: "xyz123",
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json<{ total: number; matches: unknown[] }>();
    expect(data.total).toBe(0);
    expect(data.matches.length).toBe(0);
  });

  it("POST /api/grep returns 400 for invalid regex", async () => {
    await ensureSchema();
    await ingestFile("wiki/mcp-grep-invalid.md", "Hello world");

    const response = await SELF.fetch("http://localhost/api/grep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/mcp-grep-invalid.md",
        pattern: "[invalid",
      }),
    });

    expect(response.status).toBe(400);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("INVALID_REGEX");
  });

  it("POST /api/grep returns 404 for unknown file", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/grep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/nonexistent.md",
        pattern: "test",
      }),
    });

    expect(response.status).toBe(404);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("NOT_FOUND");
  });
});
