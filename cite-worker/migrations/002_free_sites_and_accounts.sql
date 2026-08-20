-- 002: free-site classification, agent playbooks, accounts, query log.
-- Applied to the live cite-v0 D1. Safe to re-run except the ALTERs (which
-- error harmlessly if the column exists).

ALTER TABLE sites ADD COLUMN acquisition_mode TEXT DEFAULT 'paid_placement';
ALTER TABLE sites ADD COLUMN cost_type TEXT DEFAULT 'paid';
ALTER TABLE sites ADD COLUMN requires_reciprocal_link INTEGER DEFAULT 0;
ALTER TABLE sites ADD COLUMN agent_instructions TEXT;

CREATE TABLE IF NOT EXISTS accounts (
  api_key TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  tier TEXT DEFAULT 'free',
  created_at TEXT,
  orders_used INTEGER DEFAULT 0,
  quota INTEGER DEFAULT 10,
  stripe_customer_id TEXT
);

CREATE TABLE IF NOT EXISTS free_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT,
  api_key TEXT,
  target_url TEXT,
  anchor_text TEXT,
  state TEXT DEFAULT 'claimed',
  published_url TEXT,
  created_at TEXT
);

-- The demand instrument: every tool call, logged. Query volume is what decides
-- whether the paid money path gets built (SPEC §15).
CREATE TABLE IF NOT EXISTS query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key TEXT,
  tool TEXT,
  args TEXT,
  result_count INTEGER,
  at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sites_cost ON sites(cost_type);
CREATE INDEX IF NOT EXISTS idx_sites_mode ON sites(acquisition_mode);
CREATE INDEX IF NOT EXISTS idx_qlog_at ON query_log(at);
