import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureSchema } from "./setup";

const SAMPLE_MARKDOWN = `---
title: Test Page
tags: [test]
---
## Introduction
This is a test page about [[Tool Attention]] and related concepts.

## Details
The system uses markdown chunking with overlap to preserve context.
It should not split [[Wikilinks]] across chunk boundaries.`;

describe("POST /api/ingest — validation", () => {
  it("rejects missing file_key", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test", file_type: "wiki_page" }),
    });
    expect(response.status).toBe(400);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects missing content", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/test.md",
        file_type: "wiki_page",
      }),
    });
    expect(response.status).toBe(400);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid file_type", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/test.md",
        content: "test",
        file_type: "invalid",
      }),
    });
    expect(response.status).toBe(400);
    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects empty body", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/ingest — successful ingestion", () => {
  it("ingests a markdown file and returns chunk count", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/concepts/Test.md",
        content: SAMPLE_MARKDOWN,
        file_type: "wiki_page",
        title: "Test Page",
        source: "wiki/concepts/Test.md",
      }),
    });
    expect(response.status).toBe(200);
    const data = await response.json<{
      file_key: string;
      chunk_count: number;
      status: string;
    }>();
    expect(data.file_key).toBe("wiki/concepts/Test.md");
    expect(data.chunk_count).toBeGreaterThan(0);
    expect(data.status).toBe("ok");
  });

  it("stores raw content in R2", async () => {
    await ensureSchema();
    await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/r2-test.md",
        content: "## Hello\nWorld",
        file_type: "wiki_page",
      }),
    });

    const { env } = await import("cloudflare:test");
    const r2 = (env as unknown as { RAW_BUCKET: R2Bucket }).RAW_BUCKET;
    const obj = await r2.get("wiki/r2-test.md");
    expect(obj).not.toBeNull();
    const text = await obj!.text();
    expect(text).toBe("## Hello\nWorld");
  });

  it("persists file metadata in D1", async () => {
    await ensureSchema();
    await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/d1-test.md",
        content: "## Section\nContent here",
        file_type: "wiki_page",
        title: "D1 Test",
        source: "wiki/d1-test.md",
      }),
    });

    const { env } = await import("cloudflare:test");
    const db = (env as unknown as { DB: D1Database }).DB;
    const file = await db
      .prepare("SELECT * FROM files WHERE file_key = ?")
      .bind("wiki/d1-test.md")
      .first<{ file_key: string; file_type: string; title: string }>();
    expect(file).not.toBeNull();
    expect(file!.file_type).toBe("wiki_page");
    expect(file!.title).toBe("D1 Test");
  });

  it("persists chunks in D1", async () => {
    await ensureSchema();
    await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/chunks-test.md",
        content: SAMPLE_MARKDOWN,
        file_type: "wiki_page",
      }),
    });

    const { env } = await import("cloudflare:test");
    const db = (env as unknown as { DB: D1Database }).DB;
    const chunks = await db
      .prepare("SELECT * FROM chunks WHERE file_key = ? ORDER BY chunk_index")
      .bind("wiki/chunks-test.md")
      .all<{ chunk_index: number; content: string; section: string }>();
    expect(chunks.results.length).toBeGreaterThan(0);
    expect(chunks.results[0].content).toContain("Introduction");
  });
});

describe("POST /api/ingest — re-ingestion idempotency", () => {
  it("re-ingesting same file_key overwrites without duplicates", async () => {
    await ensureSchema();
    const body = {
      file_key: "wiki/reingest-test.md",
      content: "## Original\nFirst content",
      file_type: "wiki_page",
    };

    // First ingest
    await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const { env } = await import("cloudflare:test");
    const db = (env as unknown as { DB: D1Database }).DB;
    const first = await db
      .prepare("SELECT COUNT(*) as count FROM chunks WHERE file_key = ?")
      .bind("wiki/reingest-test.md")
      .first<{ count: number }>();

    // Re-ingest with different content
    await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        content: "## Updated\nDifferent content with more text",
      }),
    });

    const second = await db
      .prepare("SELECT COUNT(*) as count FROM chunks WHERE file_key = ?")
      .bind("wiki/reingest-test.md")
      .first<{ count: number }>();

    // Should have chunks from the second ingest only, no duplicates
    const file = await db
      .prepare("SELECT chunk_count FROM files WHERE file_key = ?")
      .bind("wiki/reingest-test.md")
      .first<{ chunk_count: number }>();

    expect(second!.count).toBe(file!.chunk_count);
    expect(second!.count).not.toBe(first!.count + second!.count);
  });
});

describe("POST /api/ingest — error handling", () => {
  it("returns 404 for wrong method on /api/ingest", async () => {
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "GET",
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/ingest — push_to_github", () => {
  it("accepts push_to_github and returns github_pushed field", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/github-push-test.md",
        content: "## Test\nContent for GitHub push",
        file_type: "wiki_page",
        push_to_github: true,
      }),
    });
    expect(response.status).toBe(200);
    const data = await response.json<{
      file_key: string;
      chunk_count: number;
      status: string;
      github_pushed?: boolean;
      github_error?: string;
    }>();
    expect(data.file_key).toBe("wiki/github-push-test.md");
    expect(data.chunk_count).toBeGreaterThan(0);
    expect(data.github_pushed).toBeDefined();
    // With test GITHUB_TOKEN, the push will fail
    expect(data.github_pushed).toBe(false);
    expect(data.github_error).toBeDefined();
  });

  it("does not include github_pushed when push_to_github is not set", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "wiki/no-push-test.md",
        content: "## Test\nNo push",
        file_type: "wiki_page",
      }),
    });
    expect(response.status).toBe(200);
    const data = await response.json<{
      github_pushed?: boolean;
    }>();
    expect(data.github_pushed).toBeUndefined();
  });

  it("does not push to GitHub for ingested file type even with push_to_github", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_key: "external-file:abc123",
        content: "## External\nExternal content",
        file_type: "ingested",
        push_to_github: true,
      }),
    });
    expect(response.status).toBe(200);
    const data = await response.json<{
      github_pushed?: boolean;
    }>();
    expect(data.github_pushed).toBeUndefined();
  });
});
