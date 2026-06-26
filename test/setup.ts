import { env } from "cloudflare:test";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS files (
  file_key TEXT PRIMARY KEY,
  file_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  title TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  chunk_count INTEGER DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_key TEXT NOT NULL REFERENCES files(file_key) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  section TEXT,
  wikilinks TEXT,
  vector_id TEXT,
  UNIQUE(file_key, chunk_index)
)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
)`,
  `CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END`,
  `CREATE TABLE IF NOT EXISTS retrieve_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  total_candidates INTEGER NOT NULL,
  zero_results INTEGER NOT NULL,
  score_min REAL,
  score_max REAL,
  score_mean REAL,
  semantic_hits INTEGER NOT NULL,
  keyword_hits INTEGER NOT NULL,
  semantic_returned INTEGER NOT NULL,
  keyword_returned INTEGER NOT NULL,
  hybrid_returned INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  `CREATE INDEX IF NOT EXISTS idx_retrieve_metrics_created_at ON retrieve_metrics(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_retrieve_metrics_zero_results ON retrieve_metrics(zero_results)`,
];

export async function ensureSchema() {
  const db = (env as unknown as { DB: D1Database }).DB;
  await db.batch(STATEMENTS.map((stmt) => db.prepare(stmt)));
}
