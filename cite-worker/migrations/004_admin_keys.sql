CREATE TABLE IF NOT EXISTS admin_keys (
  key TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  label TEXT,
  created_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_keys_sub ON admin_keys(sub);
