-- 005: prepaid wallet on accounts + Checkout session log.
-- Safe to re-run except the ALTERs (those error if the column already exists).

ALTER TABLE accounts ADD COLUMN available_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN held_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS checkout_sessions (
  session_id TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  email TEXT,
  amount_cents INTEGER NOT NULL,
  checkout_url TEXT,
  idempotency_key TEXT,
  expires_at TEXT,
  created_at TEXT,
  credited_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkout_api_key ON checkout_sessions(api_key);
CREATE INDEX IF NOT EXISTS idx_checkout_idem ON checkout_sessions(api_key, idempotency_key);
