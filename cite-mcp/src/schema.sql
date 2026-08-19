-- Cite v0 schema. Private columns (domain, contact, seller_price) never leave
-- the process through MCP responses — see serialize.ts field whitelist.

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,              -- opaque handle cs_xxxxxxxxxxxx, minted at import
  domain TEXT NOT NULL UNIQUE,      -- PRIVATE until delivery (blind placements)
  contact_name TEXT,                -- PRIVATE
  contact_email TEXT,               -- PRIVATE
  point_of_contact TEXT,            -- PRIVATE (internal owner)
  note TEXT,                        -- PRIVATE (ops notes from the sheet)
  niche TEXT,
  subniche TEXT,
  seller_price REAL,                -- PRIVATE — what the publisher gets
  listed_price REAL,                -- what the buyer pays (margin rule internal)
  tier_standard INTEGER DEFAULT 0,
  tier_premium INTEGER DEFAULT 0,
  tier_platinum INTEGER DEFAULT 0,
  da REAL, dr REAL, tf REAL, cf REAL, spam REAL,
  traffic REAL,
  traffic_band TEXT,
  ahrefs_organic_keywords REAL,
  ahrefs_referring_domains REAL,
  ahrefs_backlinks REAL,
  ahrefs_rank REAL,
  ahrefs_organic_value REAL,
  cite_score INTEGER,
  link_attribute TEXT DEFAULT 'unknown',   -- dofollow|sponsored|ugc|nofollow|unknown — Shortlist team to backfill
  max_links_per_post INTEGER,              -- NULL = unknown — Shortlist team to backfill
  turnaround_sla_days INTEGER,             -- NULL = unknown — Shortlist team to backfill
  status TEXT DEFAULT 'active',
  metrics_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS site_content (
  site_id TEXT PRIMARY KEY REFERENCES sites(id),
  summary TEXT,           -- anonymized: no brand/domain identifiers
  writes_about TEXT,      -- JSON array of topic phrases
  recent_titles TEXT,     -- JSON array, scrubbed of brand tokens
  enriched_at TEXT,
  source TEXT             -- 'crawl' | 'search'
);

CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT REFERENCES sites(id),
  published_url TEXT,
  target_domain TEXT,
  anchor TEXT,
  placed_at TEXT
);
-- placements stays empty in v0: needs Shortlist's order history.

CREATE INDEX IF NOT EXISTS idx_sites_niche ON sites(niche);
CREATE INDEX IF NOT EXISTS idx_sites_score ON sites(cite_score);
CREATE INDEX IF NOT EXISTS idx_sites_price ON sites(listed_price);
