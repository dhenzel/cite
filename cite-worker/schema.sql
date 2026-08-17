-- Cite working store (D1: cite-v0). Holds the FULL private dataset — the
-- public MCP tools expose only whitelisted fields; /admin/api/* (bearer-token)
-- is the only surface that returns private columns.

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,        -- PRIVATE until delivery
  contact_name TEXT,                  -- PRIVATE
  contact_email TEXT,                 -- PRIVATE
  point_of_contact TEXT,              -- PRIVATE
  note TEXT,                          -- PRIVATE
  niche TEXT,
  subniche TEXT,
  seller_price REAL,                  -- PRIVATE — what the publisher gets
  markup REAL DEFAULT 1.6,            -- PRIVATE — per-site multiplier (SPEC §3/§16)
  listed_price REAL,                  -- derived: ceil(seller_price*markup/5)*5
  tier_standard INTEGER DEFAULT 0,
  tier_premium INTEGER DEFAULT 0,
  tier_platinum INTEGER DEFAULT 0,
  da REAL, dr REAL, tf REAL, cf REAL, spam REAL,
  traffic REAL,
  traffic_band TEXT,
  cite_score INTEGER,
  link_attribute TEXT DEFAULT 'unknown',
  max_links_per_post INTEGER,
  turnaround_sla_days INTEGER,
  status TEXT DEFAULT 'active',
  -- how a placement is obtained: paid_placement | self_serve | apply_editorial
  -- | link_exchange | unavailable  (SPEC §3)
  acquisition_mode TEXT DEFAULT 'paid_placement',
  cost_type TEXT DEFAULT 'paid',            -- paid | free
  requires_reciprocal_link INTEGER DEFAULT 0,
  agent_instructions TEXT,                  -- what an agent must do on a free site
  metrics_updated_at TEXT,
  updated_at TEXT
);

-- Agent-created accounts (SPEC §17): email captured, no card. Paid placements
-- will require a Stripe customer.
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

-- Every tool call. Query volume and zero-result searches are the demand signal
-- the free tier exists to collect (SPEC §15).
CREATE TABLE IF NOT EXISTS query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key TEXT,
  tool TEXT,
  args TEXT,
  result_count INTEGER,
  at TEXT
);

CREATE TABLE IF NOT EXISTS site_content (
  site_id TEXT PRIMARY KEY,
  summary TEXT,
  writes_about TEXT,
  recent_titles TEXT,
  enriched_at TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT,
  published_url TEXT,
  target_domain TEXT,
  anchor TEXT,
  placed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sites_niche ON sites(niche);
CREATE INDEX IF NOT EXISTS idx_sites_score ON sites(cite_score);
CREATE INDEX IF NOT EXISTS idx_sites_price ON sites(listed_price);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);

-- ---------------------------------------------------------------------------
-- Shortlist Context Engine SSO (SPEC §18). Humans sign in with their engine
-- account; the same access token reads engine data as them over MCP.
-- ---------------------------------------------------------------------------

-- Keyed on the OIDC `sub` claim, never on email — email can change, sub cannot.
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  first_seen TEXT,
  last_seen TEXT,
  last_abilities TEXT      -- JSON array from probe-tool, for auditing who holds what
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  access_token TEXT,
  access_expires_at TEXT,
  abilities TEXT,
  is_admin INTEGER DEFAULT 0,
  engine_unauthorized INTEGER DEFAULT 0,
  created_at TEXT,
  last_seen TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_sub ON sessions(sub);

-- In-flight authorization requests: PKCE verifier + state + nonce, 5 min TTL.
CREATE TABLE IF NOT EXISTS oidc_flows (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  redirect_to TEXT,
  created_at TEXT
);

-- Short-TTL cache so a dashboard render doesn't hammer the engine or its audit log.
CREATE TABLE IF NOT EXISTS engine_cache (
  key TEXT PRIMARY KEY,
  sub TEXT,
  payload TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_engine_cache_exp ON engine_cache(expires_at);
