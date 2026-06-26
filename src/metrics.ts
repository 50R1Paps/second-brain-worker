import { jsonResponse } from "./http";
import type { Env, MetricsSummary } from "./types";

export async function doMetrics(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "24h";

  const validPeriods: Record<string, string> = {
    "1h": "-1 hour",
    "24h": "-24 hours",
    "7d": "-7 days",
    "30d": "-30 days",
  };
  const sqliteModifier = validPeriods[period];
  if (!sqliteModifier) {
    return jsonResponse(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid period. Valid values: ${Object.keys(validPeriods).join(", ")}`,
        },
      },
      400,
    );
  }

  try {
    const summary = await env.DB.prepare(
      `SELECT
         COUNT(*) as total_queries,
         SUM(zero_results) as zero_result_queries,
         AVG(latency_ms) as avg_latency_ms,
         AVG(result_count) as avg_result_count,
         AVG(score_mean) as avg_score_mean,
         AVG(semantic_hits) as avg_semantic_hits,
         AVG(keyword_hits) as avg_keyword_hits,
         AVG(total_candidates) as avg_total_candidates,
         SUM(semantic_returned) as total_semantic,
         SUM(keyword_returned) as total_keyword,
         SUM(hybrid_returned) as total_hybrid
       FROM retrieve_metrics
       WHERE created_at >= datetime('now', ?)`,
    )
      .bind(sqliteModifier)
      .first<{
        total_queries: number;
        zero_result_queries: number;
        avg_latency_ms: number;
        avg_result_count: number;
        avg_score_mean: number | null;
        avg_semantic_hits: number;
        avg_keyword_hits: number;
        avg_total_candidates: number;
        total_semantic: number;
        total_keyword: number;
        total_hybrid: number;
      }>();

    if (!summary || summary.total_queries === 0) {
      return jsonResponse({
        period,
        total_queries: 0,
        zero_result_queries: 0,
        zero_result_rate: 0,
        avg_latency_ms: 0,
        p50_latency_ms: null,
        p95_latency_ms: null,
        avg_result_count: 0,
        avg_score_mean: null,
        search_type_distribution: { semantic: 0, keyword: 0, hybrid: 0 },
        avg_semantic_hits: 0,
        avg_keyword_hits: 0,
        avg_total_candidates: 0,
      } satisfies MetricsSummary);
    }

    // Percentiles via sorted subquery
    const percentiles = await env.DB.prepare(
      `SELECT latency_ms FROM retrieve_metrics
       WHERE created_at >= datetime('now', ?)
       ORDER BY latency_ms`,
    )
      .bind(sqliteModifier)
      .all<{ latency_ms: number }>();

    const latencies = percentiles.results?.map((r) => r.latency_ms) ?? [];
    const p50 =
      latencies.length > 0
        ? latencies[Math.floor(latencies.length * 0.5)]
        : null;
    const p95 =
      latencies.length > 0
        ? latencies[
            Math.min(Math.floor(latencies.length * 0.95), latencies.length - 1)
          ]
        : null;

    const result: MetricsSummary = {
      period,
      total_queries: summary.total_queries,
      zero_result_queries: summary.zero_result_queries ?? 0,
      zero_result_rate: summary.zero_result_queries / summary.total_queries,
      avg_latency_ms: Math.round(summary.avg_latency_ms),
      p50_latency_ms: p50,
      p95_latency_ms: p95,
      avg_result_count: Math.round(summary.avg_result_count * 100) / 100,
      avg_score_mean:
        summary.avg_score_mean !== null
          ? Math.round(summary.avg_score_mean * 1000) / 1000
          : null,
      search_type_distribution: {
        semantic: summary.total_semantic ?? 0,
        keyword: summary.total_keyword ?? 0,
        hybrid: summary.total_hybrid ?? 0,
      },
      avg_semantic_hits: Math.round(summary.avg_semantic_hits * 100) / 100,
      avg_keyword_hits: Math.round(summary.avg_keyword_hits * 100) / 100,
      avg_total_candidates:
        Math.round(summary.avg_total_candidates * 100) / 100,
    };

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse(
      {
        error: {
          code: "METRICS_FAILED",
          message:
            err instanceof Error ? err.message : "Unknown error fetching metrics",
        },
      },
      500,
    );
  }
}
