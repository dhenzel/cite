-- Cite working store (D1: cite-v0). Holds the FULL private dataset — the
-- public MCP tools expose only whitelisted fields; /admin/api/* (bearer-token)
-- is the only surface that returns private columns.
DROP TABLE IF EXISTS sites;
DROP TABLE IF EXISTS site_content;
DROP TABLE IF EXISTS placements;
DROP TABLE IF EXISTS sites_public;

CREATE TABLE sites (
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
  metrics_updated_at TEXT,
  updated_at TEXT
);

CREATE TABLE site_content (
  site_id TEXT PRIMARY KEY,
  summary TEXT,
  writes_about TEXT,
  recent_titles TEXT,
  enriched_at TEXT,
  source TEXT
);

CREATE TABLE placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT,
  published_url TEXT,
  target_domain TEXT,
  anchor TEXT,
  placed_at TEXT
);

CREATE INDEX idx_sites_niche ON sites(niche);
CREATE INDEX idx_sites_score ON sites(cite_score);
CREATE INDEX idx_sites_price ON sites(listed_price);
CREATE INDEX idx_sites_status ON sites(status);
CREATE INDEX idx_sites_domain ON sites(domain);
