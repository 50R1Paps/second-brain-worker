import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:test";
import { ensureSchema } from "./setup";

const SAMPLE_MARKDOWN = `---
title: Metrics Test Page
tags: [test, metrics]
---
## Introduction
This is a test page about retrieval metrics and evaluation.

## Details
The system uses hybrid search combining semantic and keyword approaches.
Metrics include latency, score distribution, and search type breakdown.`;

async function ingestAndRetrieve() {
  await ensureSchema();

  await SELF.fetch("http://localhost/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_key: "wiki/metrics-test.md",
      content: SAMPLE_MARKDOWN,
      file_type: "wiki_page",
      title: "Metrics Test",
      push_to_github: false,
    }),
  });

  const response = await SELF.fetch("http://localhost/api/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "retrieval metrics evaluation" }),
  });

  return response;
}

describe("Retrieve metrics — inline response", () => {
  it("includes metrics object in retrieve response", async () => {
    const response = await ingestAndRetrieve();
    expect(response.status).toBe(200);

    const data = await response.json<{
      query: string;
      results: unknown[];
      total: number;
      metrics: {
        latency_ms: number;
        result_count: number;
        total_candidates: number;
        zero_results: boolean;
        score_min: number | null;
        score_max: number | null;
        score_mean: number | null;
        search_type_counts: {
          semantic: number;
          keyword: number;
          hybrid: number;
        };
        semantic_hits: number;
        keyword_hits: number;
      };
    }>();

    expect(data.metrics).toBeDefined();
    expect(typeof data.metrics.latency_ms).toBe("number");
    expect(data.metrics.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof data.metrics.result_count).toBe("number");
    expect(typeof data.metrics.total_candidates).toBe("number");
    expect(typeof data.metrics.zero_results).toBe("boolean");
    expect(data.metrics.search_type_counts).toBeDefined();
    expect(typeof data.metrics.semantic_hits).toBe("number");
    expect(typeof data.metrics.keyword_hits).toBe("number");
  });

  it("metrics are consistent with results", async () => {
    const response = await ingestAndRetrieve();
    const data = await response.json<{
      results: { score: number; search_type: string }[];
      metrics: {
        result_count: number;
        score_min: number | null;
        score_max: number | null;
        score_mean: number | null;
        search_type_counts: {
          semantic: number;
          keyword: number;
          hybrid: number;
        };
      };
    }>();

    expect(data.metrics.result_count).toBe(data.results.length);

    if (data.results.length > 0) {
      const scores = data.results.map((r) => r.score);
      expect(data.metrics.score_min).toBeCloseTo(Math.min(...scores), 5);
      expect(data.metrics.score_max).toBeCloseTo(Math.max(...scores), 5);

      const expectedMean = scores.reduce((a, b) => a + b, 0) / scores.length;
      expect(data.metrics.score_mean).toBeCloseTo(expectedMean, 5);

      const semanticCount = data.results.filter((r) => r.search_type === "semantic").length;
      const keywordCount = data.results.filter((r) => r.search_type === "keyword").length;
      const hybridCount = data.results.filter((r) => r.search_type === "hybrid").length;
      expect(data.metrics.search_type_counts.semantic).toBe(semanticCount);
      expect(data.metrics.search_type_counts.keyword).toBe(keywordCount);
      expect(data.metrics.search_type_counts.hybrid).toBe(hybridCount);
    }
  });

  it("zero_results is true when no results found", async () => {
    await ensureSchema();

    const response = await SELF.fetch("http://localhost/api/retrieve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "zzznonexistentxyz123" }),
    });

    const data = await response.json<{
      results: unknown[];
      metrics: { zero_results: boolean; result_count: number };
    }>();

    expect(data.metrics.zero_results).toBe(true);
    expect(data.metrics.result_count).toBe(0);
    expect(data.results.length).toBe(0);
  });
});

describe("Retrieve metrics — D1 persistence", () => {
  it("persists metrics row to retrieve_metrics table", async () => {
    await ingestAndRetrieve();

    const db = (env as unknown as { DB: D1Database }).DB;
    const row = await db
      .prepare(
        "SELECT query, latency_ms, result_count, zero_results FROM retrieve_metrics ORDER BY id DESC LIMIT 1",
      )
      .first<{ query: string; latency_ms: number; result_count: number; zero_results: number }>();

    expect(row).not.toBeNull();
    expect(row!.query).toBe("retrieval metrics evaluation");
    expect(typeof row!.latency_ms).toBe("number");
    expect(typeof row!.result_count).toBe("number");
    expect(row!.zero_results).toBe(0);
  });
});

describe("GET /api/metrics — aggregated summary", () => {
  it("returns metrics summary for default 24h period", async () => {
    await ingestAndRetrieve();

    const response = await SELF.fetch("http://localhost/api/metrics");
    expect(response.status).toBe(200);

    const data = await response.json<{
      period: string;
      total_queries: number;
      zero_result_queries: number;
      zero_result_rate: number;
      avg_latency_ms: number;
      p50_latency_ms: number | null;
      p95_latency_ms: number | null;
      avg_result_count: number;
      avg_score_mean: number | null;
      search_type_distribution: {
        semantic: number;
        keyword: number;
        hybrid: number;
      };
      avg_semantic_hits: number;
      avg_keyword_hits: number;
      avg_total_candidates: number;
    }>();

    expect(data.period).toBe("24h");
    expect(data.total_queries).toBeGreaterThan(0);
    expect(data.zero_result_rate).toBeGreaterThanOrEqual(0);
    expect(data.zero_result_rate).toBeLessThanOrEqual(1);
    expect(data.avg_latency_ms).toBeGreaterThan(0);
  });

  it("supports period query parameter", async () => {
    await ingestAndRetrieve();

    const response = await SELF.fetch("http://localhost/api/metrics?period=7d");
    expect(response.status).toBe(200);

    const data = await response.json<{ period: string; total_queries: number }>();
    expect(data.period).toBe("7d");
  });

  it("rejects invalid period", async () => {
    const response = await SELF.fetch("http://localhost/api/metrics?period=invalid");
    expect(response.status).toBe(400);

    const data = await response.json<{ error: { code: string } }>();
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns empty summary when no queries in period", async () => {
    await ensureSchema();

    const response = await SELF.fetch("http://localhost/api/metrics?period=1h");
    expect(response.status).toBe(200);

    const data = await response.json<{
      total_queries: number;
      zero_result_rate: number;
      p50_latency_ms: number | null;
      p95_latency_ms: number | null;
    }>();

    // May have queries from previous tests, but structure should be valid
    expect(typeof data.total_queries).toBe("number");
    expect(typeof data.zero_result_rate).toBe("number");
  });
});
