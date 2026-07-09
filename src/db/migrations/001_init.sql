CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL, -- unix ms
  updated_at INTEGER NOT NULL  -- unix ms
);

CREATE TABLE IF NOT EXISTS synced_receipts (
  etsy_receipt_id TEXT PRIMARY KEY,
  shopify_order_id TEXT,
  status TEXT NOT NULL, -- 'synced' | 'needs_review' | 'error'
  reason TEXT,
  error_detail TEXT,
  receipt_created_ts INTEGER NOT NULL, -- unix seconds, from Etsy
  synced_at INTEGER NOT NULL -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_synced_receipts_status ON synced_receipts(status);
CREATE INDEX IF NOT EXISTS idx_synced_receipts_created_ts ON synced_receipts(receipt_created_ts);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL, -- unix ms
  receipts_seen INTEGER NOT NULL,
  receipts_synced INTEGER NOT NULL,
  receipts_skipped INTEGER NOT NULL,
  errors_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoint (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
