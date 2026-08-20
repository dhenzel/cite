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
  ahrefs_organic_keywords REAL,
  ahrefs_referring_domains REAL,
  ahrefs_backlinks REAL,
  ahrefs_rank REAL,
  ahrefs_organic_value REAL,
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
  stripe_customer_id TEXT,
  available_cents INTEGER NOT NULL DEFAULT 0,
  held_cents INTEGER NOT NULL DEFAULT 0
);

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

-- Agent-submitted posts. Domain stays off buyer tools until published.
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
  source TEXT,
  audience TEXT,
  tone TEXT,
  post_shape TEXT,
  typical_length_words INTEGER,
  do_fit TEXT,
  dont_fit TEXT,
  summary_private TEXT,
  enrich_status TEXT
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

-- Per-person keys for the admin MCP (SPEC §16). Minted from the console after
-- a Shortlist sign-in, so every bulk edit is attributable and revocable per
-- person instead of sharing one ADMIN_TOKEN.
CREATE TABLE IF NOT EXISTS admin_keys (
  key TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  label TEXT,
  created_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_keys_sub ON admin_keys(sub);

-- ---------- free placement opportunities (migration 010) ----------
-- The second product line: places a customer can get listed, profiled or
-- published for nothing. Separate from `sites`, which is paid publishers only.
-- `contribution` says what the customer contributes: an article, a company
-- profile, or an application to a program.

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,               -- 'workbook-2026-08' | 'shortlist-sheet'
  legacy_site_id TEXT,                -- sites.id when migrated from the paid table
  related_opportunity_id TEXT,        -- same platform, different opportunity class
  platform TEXT NOT NULL,
  domain TEXT,                        -- PRIVATE-ish: public here (these are open programs)
  submission_url TEXT,

  -- the merge axis
  contribution TEXT NOT NULL DEFAULT 'profile',  -- 'article' | 'profile' | 'program'
  opportunity_type TEXT,
  opportunity_class TEXT,
  best_for TEXT,
  niche TEXT,
  platform_audience TEXT,
  relevant_industries TEXT,

  -- cost: "free" means several different things, so model it explicitly
  cost_model TEXT,
  cost_confidence TEXT,               -- 'confirmed' | 'secondary' | 'unknown'
  is_free_confirmed INTEGER DEFAULT 0,
  requires_reciprocal_link INTEGER DEFAULT 0,

  -- link: a claim from the source, never a promise to the buyer
  link_attribute_claim TEXT DEFAULT 'unknown',
  primary_benefit TEXT,

  -- trust
  verification_level TEXT,
  last_checked TEXT,
  priority_score INTEGER,
  priority_tier TEXT,
  needs_reverification INTEGER DEFAULT 1,

  -- metrics, carried over for migrated rows that have them
  dr REAL,
  traffic REAL,
  cite_score INTEGER,

  -- hard gates: real columns because this is the filter surface
  services_allowed TEXT,              -- 'Yes' | 'No' | 'Conditional'
  requires_software INTEGER DEFAULT 0,
  requires_ai INTEGER DEFAULT 0,
  requires_open_source INTEGER DEFAULT 0,
  requires_integration INTEGER DEFAULT 0,
  requires_location INTEGER DEFAULT 0,
  requires_customers INTEGER DEFAULT 0,
  requires_launch INTEGER DEFAULT 0,
  requires_visuals INTEGER DEFAULT 0,
  requires_license INTEGER DEFAULT 0,
  requires_certification INTEGER DEFAULT 0,
  requires_membership INTEGER DEFAULT 0,

  -- gate prose
  eligible_entity_types TEXT,
  geographic_eligibility TEXT,
  company_stage TEXT,
  hard_exclusions TEXT,
  fit_question TEXT,

  -- operator-only — never serialized on /mcp
  contact_email TEXT,
  note TEXT,
  agent_instructions TEXT,
  discovery_source TEXT,
  verification_source TEXT,

  -- preparation facts that really are per-row (the rest lives on the playbook)
  prep_minutes INTEGER,
  requirement_confidence TEXT,
  requirements_source TEXT,
  agent_prompt TEXT,

  playbook_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'watchlist' | 'retired'
  created_at TEXT,
  updated_at TEXT,

  -- migration 011: what a live page read found, per row. The playbook above is
  -- the class-level fallback; these override it when present.
  verified_cost_model TEXT,
  verified_is_free INTEGER,
  verified_requirements TEXT,             -- JSON
  verified_eligibility TEXT,              -- JSON
  verified_submission_mechanism TEXT,
  verified_at TEXT,
  verify_source TEXT,                     -- 'llm-page-read-v1' | 'operator'
  verify_note TEXT,
  liveness TEXT,                          -- live | dead | blocked | unknown
  http_status INTEGER,
  final_url TEXT,
  crawl_checked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_opp_verified ON opportunities(verified_at);
CREATE INDEX IF NOT EXISTS idx_opp_liveness ON opportunities(liveness);
CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opp_contribution ON opportunities(contribution);
CREATE INDEX IF NOT EXISTS idx_opp_niche ON opportunities(niche);
CREATE INDEX IF NOT EXISTS idx_opp_tier ON opportunities(priority_tier);
CREATE INDEX IF NOT EXISTS idx_opp_score ON opportunities(priority_score);
CREATE INDEX IF NOT EXISTS idx_opp_legacy ON opportunities(legacy_site_id);

-- The workbook repeats the same instructions on every row: `Agent Can Do` has
-- exactly ONE distinct value across all 843, the requirements blob has 19 and
-- the execution blob 17, for 70 distinct combinations in total. So a playbook is
-- the unit of truth here — what this CLASS of opportunity asks for — and an
-- opportunity points at one instead of carrying its own copy.
CREATE TABLE IF NOT EXISTS opportunity_playbooks (
  id TEXT PRIMARY KEY,
  automation_level TEXT,
  agent_mode TEXT,
  agent_can_do TEXT,
  human_must_do TEXT,
  action_recipe TEXT,
  safety_guardrail TEXT,
  -- what to prepare
  recommended_action TEXT,
  required_form_information TEXT,
  copy_to_prepare TEXT,
  assets_to_prepare TEXT,
  eligibility_proof TEXT,
  customer_only_inputs TEXT,
  agent_can_infer TEXT,
  -- what stands in the way
  account_verification TEXT,
  human_handoff TEXT,
  login_auth TEXT,
  captcha TEXT,
  email_verification TEXT,
  editorial_approval TEXT,
  likely_blockers TEXT,
  required_credentials TEXT,
  autonomy_score INTEGER
);

-- Reference data the agent reads when matching and preparing.
CREATE TABLE IF NOT EXISTS earned_link_plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  play TEXT, what_you_do TEXT, cost TEXT, reciprocal TEXT,
  likely_link_value TEXT, guardrail TEXT, where_to_look TEXT
);

CREATE TABLE IF NOT EXISTS strategic_programs (
  id TEXT PRIMARY KEY,
  platform TEXT, opportunity_class TEXT, niche TEXT, action TEXT,
  primary_value TEXT, cost_model TEXT, hard_requirements TEXT,
  best_next_action TEXT, agent_mode TEXT, human_checkpoint TEXT,
  url TEXT, confidence TEXT, status TEXT
);

CREATE TABLE IF NOT EXISTS niche_coverage (
  niche TEXT PRIMARY KEY,
  reachable INTEGER, free_freemium INTEGER, license_gated INTEGER,
  certification_gated INTEGER, membership_gated INTEGER,
  key_hard_gates TEXT, example_platforms TEXT
);

-- The 43 canonical company fields. analyze_site fills these; prepare_submission
-- maps them onto a platform's form.
CREATE TABLE IF NOT EXISTS field_library (
  field TEXT PRIMARY KEY,
  data_type TEXT, owner TEXT, source TEXT, guardrail TEXT, used_by TEXT
);

-- ---------- customer side ----------
-- Free forever means no account: a workspace_key is minted by analyze_site and
-- is the only identity a customer needs. Email stays optional.
CREATE TABLE IF NOT EXISTS company_profiles (
  id TEXT PRIMARY KEY,
  workspace_key TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  name TEXT,
  evidence TEXT,                      -- JSON: attributes + per-attribute confidence
  unknowns TEXT,                      -- JSON: what we could not determine
  email TEXT,
  api_key TEXT,                       -- set if they also hold a paid account
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_company_workspace ON company_profiles(workspace_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_url ON company_profiles(workspace_key, canonical_url);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'matched',
  -- matched | prepared | submitted | pending | live | rejected | skipped | needs_human
  packet TEXT,                        -- JSON: exact values prepared/submitted
  receipt_url TEXT,
  published_url TEXT,
  observed_rel TEXT,                  -- what the live link ACTUALLY carries
  observed_indexed INTEGER,
  account_owner TEXT,
  reference TEXT,
  next_check_at TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_idem ON submissions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_sub_company ON submissions(company_id);
CREATE INDEX IF NOT EXISTS idx_sub_state ON submissions(state);
CREATE INDEX IF NOT EXISTS idx_sub_next_check ON submissions(next_check_at);

CREATE TABLE IF NOT EXISTS submission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT,                         -- 'agent' | 'human'
  evidence TEXT,
  at TEXT
);
CREATE INDEX IF NOT EXISTS idx_subev_submission ON submission_events(submission_id);
