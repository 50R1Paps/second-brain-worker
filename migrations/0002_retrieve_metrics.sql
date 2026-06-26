-- Migration 0002: Retrieve metrics for runtime observability

CREATE TABLE IF NOT EXISTS retrieve_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  total_candidates INTEGER NOT NULL,
  zero_results INTEGER NOT NULL,           -- 0 | 1
  score_min REAL,
  score_max REAL,
  score_mean REAL,
  semantic_hits INTEGER NOT NULL,
  keyword_hits INTEGER NOT NULL,
  semantic_returned INTEGER NOT NULL,
  keyword_returned INTEGER NOT NULL,
  hybrid_returned INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_retrieve_metrics_created_at
  ON retrieve_metrics(created_at);

CREATE INDEX IF NOT EXISTS idx_retrieve_metrics_zero_results
  ON retrieve_metrics(zero_results);
