-- Migration 0001: Initial schema for Second Brain

-- Metadata dei file indicizzati
CREATE TABLE IF NOT EXISTS files (
  file_key TEXT PRIMARY KEY,
  file_type TEXT NOT NULL,        -- 'wiki_page' | 'ingested'
  r2_key TEXT NOT NULL,
  title TEXT,
  source TEXT,                    -- URL o path sorgente
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  chunk_count INTEGER DEFAULT 0
);

-- Chunk con riferimento al file e posizione
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_key TEXT NOT NULL REFERENCES files(file_key) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,          -- testo del chunk
  section TEXT,                   -- titolo sezione (es. "## Architecture")
  wikilinks TEXT,                 -- JSON array di wikilink nel chunk
  vector_id TEXT,                 -- ID in Vectorize
  UNIQUE(file_key, chunk_index)
);

-- Indice full-text per keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Trigger per mantenere FTS sincronizzato
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
