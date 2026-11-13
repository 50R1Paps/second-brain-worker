-- Atomic budgets and signed webhook delivery receipts. No raw IPs or tokens.
CREATE TABLE IF NOT EXISTS request_counters (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count >= 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_counters_expiry ON request_counters(expires_at);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  digest TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'done')),
  lease_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_receipts_expiry ON webhook_receipts(expires_at);

-- Historical search text is not needed for aggregate operational metrics.
UPDATE retrieve_metrics SET query = '' WHERE query <> '';
