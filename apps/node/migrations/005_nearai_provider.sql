-- migrate: foreign-keys-off
-- NEAR AI Cloud becomes a provider of its own: ai_connections.provider also accepts 'nearai'.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt the way sqlite.org/lang_altertable.html prescribes:
-- same columns in the same order, every row copied, then the new table takes the old name. agents and agent_runs
-- reference ai_connections by name and keep doing so; the runner checks every foreign key before it commits.
CREATE TABLE ai_connections_new (
  id                  TEXT PRIMARY KEY,                -- aic_...
  merchant_id         TEXT NOT NULL REFERENCES merchants (id),
  provider            TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google', 'openai_compatible', 'replicate', 'nearai')),
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

INSERT INTO ai_connections_new
  (id, merchant_id, provider, label, base_url, default_model, key_hint, key_ciphertext, key_iv, key_tag, key_version,
   status, verified_at, last_error, monthly_token_limit, created_at, created_by, rotated_at, updated_at, deleted_at)
SELECT
   id, merchant_id, provider, label, base_url, default_model, key_hint, key_ciphertext, key_iv, key_tag, key_version,
   status, verified_at, last_error, monthly_token_limit, created_at, created_by, rotated_at, updated_at, deleted_at
FROM ai_connections;

DROP TABLE ai_connections;
ALTER TABLE ai_connections_new RENAME TO ai_connections;
CREATE INDEX ai_connections_merchant ON ai_connections (merchant_id, created_at);
