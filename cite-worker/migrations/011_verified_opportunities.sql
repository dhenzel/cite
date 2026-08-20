-- 011: facts read from an opportunity's live page, kept apart from the class template.
--
-- The 2026-08 import gave every row a playbook: what a directory / marketplace /
-- partner program of that KIND asks for. Useful, but 1,549 of 1,550 rows carried
-- `needs_reverification` because nobody had opened the actual page.
--
-- These columns hold what a live read found, per row. The playbook stays as the
-- fallback, so a verified row answers from the page and an unverified one still
-- answers from the class — and every payload says which.
--
-- Two rules the writer must keep (enforced in scripts/verify-opportunities.mts):
--   * needs_reverification is cleared ONLY when a page read actually succeeded.
--   * requires_license / requires_certification / requires_membership are never
--     written here. A web page cannot establish a credential, and guessing one
--     puts a false claim on a customer's real application.

ALTER TABLE opportunities ADD COLUMN verified_cost_model TEXT;
ALTER TABLE opportunities ADD COLUMN verified_is_free INTEGER;
ALTER TABLE opportunities ADD COLUMN verified_requirements TEXT;      -- JSON
ALTER TABLE opportunities ADD COLUMN verified_eligibility TEXT;       -- JSON
ALTER TABLE opportunities ADD COLUMN verified_submission_mechanism TEXT;
ALTER TABLE opportunities ADD COLUMN verified_at TEXT;
ALTER TABLE opportunities ADD COLUMN verify_source TEXT;              -- 'llm-page-read-v1' | 'operator'
ALTER TABLE opportunities ADD COLUMN verify_note TEXT;                -- disagreements, for an operator

-- Liveness is separate from verification: a page can be reachable and still tell
-- us nothing, and a 403 means firewalled, not gone.
ALTER TABLE opportunities ADD COLUMN liveness TEXT;                   -- live | dead | blocked | unknown
ALTER TABLE opportunities ADD COLUMN http_status INTEGER;
ALTER TABLE opportunities ADD COLUMN final_url TEXT;                  -- after redirects
ALTER TABLE opportunities ADD COLUMN crawl_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_opp_verified ON opportunities(verified_at);
CREATE INDEX IF NOT EXISTS idx_opp_liveness ON opportunities(liveness);
