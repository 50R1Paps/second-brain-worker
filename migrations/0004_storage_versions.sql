-- Staged and obsolete objects are retained for at least 24 hours.
CREATE TABLE IF NOT EXISTS storage_gc (
  kind TEXT NOT NULL CHECK (kind IN ('raw', 'vector')),
  storage_key TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  PRIMARY KEY (kind, storage_key)
);
CREATE INDEX IF NOT EXISTS storage_gc_due ON storage_gc(not_before);
