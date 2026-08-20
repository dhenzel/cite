-- 010: free placement opportunities — the second product line.
--
-- placement.sh sells paid publisher placements out of `sites`. This migration
-- adds the free side: places a customer can get listed, profiled, or published
-- at no cost, where the agent does the matching and the preparation and a human
-- does the login / CAPTCHA / final approval.
--
-- One catalog, two populations that barely overlap (12 domains in common):
--   * the 499 cost_type='free' rows already in `sites` — guest-post blogs and
--     self-publish platforms, where the customer writes an ARTICLE
--   * the 843 researched rows from the 2026-08 workbook — directories,
--     marketplaces, review sites and partner programs, where the customer's
--     company gets a PROFILE
-- `contribution` is what separates them.
--
-- Honesty is enforced in the schema, not just the copy: cost_model carries a
-- confidence, link_attribute is a CLAIM, and needs_reverification marks every
-- row whose requirements came from a class template rather than a live page
-- (836 of 843 in the source workbook).

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
  updated_at TEXT
);
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

-- ---------- merge the 499 free publisher rows in ----------
-- Idempotent: re-running skips rows already carried over. The source rows are
-- ARCHIVED rather than deleted, so publisher contacts stay where the operator
-- console expects them and the move is reversible.
INSERT OR IGNORE INTO opportunities (
  id, source, legacy_site_id, platform, domain, submission_url,
  contribution, opportunity_type, opportunity_class, best_for, niche,
  cost_model, cost_confidence, is_free_confirmed, requires_reciprocal_link,
  link_attribute_claim, primary_benefit,
  verification_level, last_checked, priority_score, priority_tier, needs_reverification,
  dr, traffic, cite_score,
  services_allowed, eligible_entity_types, geographic_eligibility,
  contact_email, note, agent_instructions, discovery_source,
  playbook_id, status, created_at, updated_at
)
SELECT
  'opp_site_' || s.id,
  'shortlist-sheet',
  s.id,
  s.domain,
  s.domain,
  'https://' || s.domain,
  'article',
  CASE COALESCE(s.acquisition_mode,'apply_editorial')
    WHEN 'self_serve'      THEN 'Self-publish platform'
    WHEN 'link_exchange'   THEN 'Reciprocal link exchange'
    WHEN 'apply_editorial' THEN 'Guest post pitch'
    ELSE 'Guest post pitch'
  END,
  COALESCE(s.acquisition_mode,'apply_editorial'),
  'Companies with something worth writing about',
  s.niche,
  CASE COALESCE(s.acquisition_mode,'apply_editorial')
    WHEN 'link_exchange' THEN 'Free listing requiring a reciprocal link'
    WHEN 'self_serve'    THEN 'Completely free submission'
    ELSE 'Free but editorial contribution required'
  END,
  'secondary',
  CASE WHEN COALESCE(s.seller_price,0) = 0 THEN 1 ELSE 0 END,
  COALESCE(s.requires_reciprocal_link, 0),
  COALESCE(s.link_attribute, 'unknown'),
  'Editorial placement; referral traffic',
  'Reachability confirmed + secondary source',
  s.metrics_updated_at,
  COALESCE(s.cite_score, 0),
  CASE WHEN COALESCE(s.cite_score,0) >= 60 THEN 'Tier 1'
       WHEN COALESCE(s.cite_score,0) >= 40 THEN 'Tier 2' ELSE 'Tier 3' END,
  1,
  s.dr, s.traffic, s.cite_score,
  'Yes',
  'Any company with a relevant story',
  'Global unless platform-specific',
  s.contact_email, s.note, s.agent_instructions,
  'Shortlist publisher sheet',
  CASE COALESCE(s.acquisition_mode,'apply_editorial')
    WHEN 'self_serve' THEN 'pb_self_serve'
    ELSE 'pb_editorial'
  END,
  CASE WHEN COALESCE(s.acquisition_mode,'') = 'unavailable' THEN 'watchlist' ELSE 'active' END,
  datetime('now'), datetime('now')
FROM sites s
WHERE COALESCE(s.cost_type,'paid') = 'free';

-- The free rows leave the paid catalog. `sites` is paid-only from here; the
-- buyer MCP already filtered them out via buyerWhere(), so nothing public moves.
UPDATE sites SET status = 'archived', updated_at = datetime('now')
WHERE COALESCE(cost_type,'paid') = 'free' AND status <> 'archived';

-- Playbooks for the migrated rows. The workbook's own playbooks are inserted
-- by the importer.
INSERT OR REPLACE INTO opportunity_playbooks (
  id, automation_level, agent_mode, agent_can_do, human_must_do, action_recipe, safety_guardrail,
  recommended_action, required_form_information, copy_to_prepare, assets_to_prepare,
  eligibility_proof, customer_only_inputs, agent_can_infer,
  account_verification, human_handoff, login_auth, captcha, email_verification,
  editorial_approval, likely_blockers, required_credentials, autonomy_score
) VALUES
('pb_editorial',
 'Semi-automated',
 'Agent prepares; human login/approval',
 'Read what the site publishes; judge topical fit; draft a pitch and an outline; write the finished post; propose the anchor and target URL; prepare the author bio and headshot.',
 'Approve the pitch and the finished post before it is sent; send the pitch from a real mailbox; agree any editorial changes the publisher asks for.',
 'CHECK the site still publishes contributions -> COMPARE topics to the company evidence -> DRAFT pitch + outline -> REQUEST missing inputs -> WRITE the post -> HUMAN approves -> HUMAN sends -> RECORD the outcome.',
 'Never send outreach from a mailbox the human has not authorised, never fabricate credentials or claims in a pitch, and never promise the publisher anything placement.sh cannot deliver.',
 'Pitch a contributed post',
 'author name | author bio | headshot | proposed title | outline | target URL | anchor text',
 'pitch email 120-200 words | working title | outline of 4-6 sections | finished post 800-1500 words | author bio 40-60 words',
 'author headshot | any original screenshots, charts or data the post needs',
 'the author is a real person with real standing to write this',
 'authorised sending mailbox | approval of the finished post | any first-party data quoted',
 'topical fit from what the site publishes | draft pitch, outline and full post | anchor and target URL suggestions',
 'No account needed; the publisher replies by email.',
 'Send the pitch; agree edits; approve the final text.',
 'Not applicable', 'Not applicable', 'Not applicable',
 'Yes — an editor accepts or rejects the pitch',
 'No reply; editor declines the topic; publication queue is long',
 'A real author identity and a mailbox to send from', 55),
('pb_self_serve',
 'High automation potential',
 'Agent can prepare + attempt submission',
 'Draft the post in the platform''s format; prepare tags, canonical URL and cover image; check the platform''s rules on promotional content and canonical links.',
 'Own the account; approve the final text; publish; confirm the link renders.',
 'OPEN the platform -> CHECK current rules on self-promotion and canonical links -> DRAFT the post -> HUMAN reviews -> HUMAN publishes from their own account -> RECORD the published URL and observed rel.',
 'Never create accounts on the human''s behalf, never mass-publish thin variations of the same post, and never hide that the author has a commercial interest.',
 'Publish from the company''s own account',
 'account handle | post title | body | tags | canonical URL',
 'title | post body 600-1200 words | 1-2 sentence summary | tag list',
 'cover image | any screenshots referenced in the post',
 'the account belongs to the company or an authorised author',
 'platform account | approval of the final text | the act of publishing',
 'post draft, tags, summary and canonical URL',
 'Platform account required; the human owns it.',
 'Log in, review, publish, then confirm the link renders.',
 'Yes — the human''s own account', 'Possible', 'Possible',
 'No — self-published',
 'Platform rules on promotional links; nofollow by default on most platforms',
 'An account the human controls', 75);
