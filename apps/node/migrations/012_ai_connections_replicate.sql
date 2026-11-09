-- migrate: foreign-keys-off
-- AI connections may use Replicate (docs/AGENTS.md section 3): provider 'replicate' joins the CHECK constraint.
-- SQLite cannot change a CHECK constraint in place, so ai_connections is rebuilt (the documented 12-step procedure);
-- the migration runner turns foreign keys off around it and runs PRAGMA foreign_key_check before committing.
-- agents and agent_runs reference ai_connections by name, so they point at the rebuilt table once it is renamed.
CREATE TABLE ai_connections_new (
  id                  TEXT PRIMARY KEY,                -- aic_...
  merchant_id         TEXT NOT NULL REFERENCES merchants (id),
  provider            TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google', 'openai_compatible', 'replicate')),
  label               TEXT NOT NULL,
  base_url            TEXT,
  default_model       TEXT NOT NULL,
  key_hint            TEXT NOT NULL,                   -- last 4 characters, for display
  key_ciphertext      TEXT NOT NULL,
  key_iv              TEXT NOT NULL,
  key_tag             TEXT NOT NULL,
  key_version         INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('active', 'invalid', 'disabled')),
  verified_at         TEXT,
  last_error          TEXT,
  monthly_token_limit INTEGER CHECK (monthly_token_limit IS NULL OR monthly_token_limit > 0),
  created_at          TEXT NOT NULL,
  created_by          TEXT,                            -- user or API key id
  rotated_at          TEXT,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
INSERT INTO ai_connections_new (id, merchant_id, provider, label, base_url, default_model, key_hint, key_ciphertext, key_iv, key_tag,
                                key_version, status, verified_at, last_error, monthly_token_limit, created_at, created_by, rotated_at,
                                updated_at, deleted_at)
SELECT id, merchant_id, provider, label, base_url, default_model, key_hint, key_ciphertext, key_iv, key_tag, key_version, status,
       verified_at, last_error, monthly_token_limit, created_at, created_by, rotated_at, updated_at, deleted_at
FROM ai_connections;
DROP TABLE ai_connections;
ALTER TABLE ai_connections_new RENAME TO ai_connections;
CREATE INDEX ai_connections_merchant ON ai_connections (merchant_id, created_at);
