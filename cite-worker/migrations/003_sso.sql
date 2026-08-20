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
