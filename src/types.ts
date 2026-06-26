export interface Env {
  RAW_BUCKET: R2Bucket;
  DB: D1Database;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_TOKEN_EXPIRY: string;
  SECOND_BRAIN_MCP: DurableObjectNamespace;
}

export interface IngestRequest {
  file_key: string;
  content: string;
  file_type: "wiki_page" | "ingested";
  title?: string;
  source?: string;
  push_to_github?: boolean;
}

export interface IngestResult {
  file_key: string;
  chunk_count: number;
  status: string;
  github_pushed?: boolean;
  github_error?: string;
}

export interface RetrieveFilter {
  file_type?: "wiki_page" | "ingested";
  section_prefix?: string;
  file_key_prefix?: string;
}

export interface RetrieveRequest {
  query: string;
  limit?: number;
  filter?: RetrieveFilter;
}

export interface RetrieveResult {
  file_key: string;
  title: string | null;
  chunk_index: number;
  section: string | null;
  content: string;
  wikilinks: string[];
  score: number;
  search_type: "semantic" | "keyword" | "hybrid";
}

export interface RetrieveMetrics {
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
}

export interface RetrieveResponse {
  query: string;
  results: RetrieveResult[];
  total: number;
  metrics: RetrieveMetrics;
}

export interface ReindexRequest {
  file_key?: string;
}

export interface ReindexResult {
  file_key: string | null;
  reindexed: number;
  status: string;
}

export interface DeleteFileResult {
  file_key: string;
  deleted: boolean;
  status: string;
}

export interface ReadRequest {
  file_key: string;
  offset?: number;
  max_chars?: number;
}

export interface ReadResult {
  file_key: string;
  content: string;
  offset: number;
  total_length: number;
  truncated: boolean;
}

export interface GrepRequest {
  file_key: string;
  pattern: string;
  max_matches?: number;
  context?: number;
}

export interface GrepMatch {
  match: string;
  start: number;
  end: number;
  context?: { text: string; start: number; end: number };
}

export interface GrepResult {
  file_key: string;
  pattern: string;
  matches: GrepMatch[];
  total: number;
}

export interface MetricsSummary {
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
}
