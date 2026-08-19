-- 006: agent-submitted posts for operator processing.
CREATE TABLE IF NOT EXISTS placement_orders (
  id TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  anchor_text TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_bio TEXT,
  listed_price_cents INTEGER NOT NULL,
  word_count INTEGER,
  body_hash TEXT,
  idempotency_key TEXT,
  state TEXT NOT NULL DEFAULT 'human_review',
  created_at TEXT,
  published_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_api_key ON placement_orders(api_key);
CREATE INDEX IF NOT EXISTS idx_orders_state ON placement_orders(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON placement_orders(api_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
