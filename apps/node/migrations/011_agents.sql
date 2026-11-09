-- Merchant AI agents (docs/AGENTS.md): a business's own model connections, its agents, their runs and run steps.
-- Additive only: new tables, plus three nullable columns on api_keys for the run-scoped keys ops agents use.
-- Times used for scheduling are unix milliseconds (the worker leases and backs off in milliseconds); the API shows ISO.

-- A business's model provider account. The key is AES-256-GCM sealed (agents/secrets.ts) and bound to merchant_id
-- and id; it is never returned, logged or audited. A deleted connection keeps its row with the ciphertext wiped.
CREATE TABLE ai_connections (
  id                  TEXT PRIMARY KEY,                -- aic_...
  merchant_id         TEXT NOT NULL REFERENCES merchants (id),
  provider            TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google', 'openai_compatible')),
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
CREATE INDEX ai_connections_merchant ON ai_connections (merchant_id, created_at);

-- An agent of a business. Skills also own a provider row (the paywall's registration) and its provider key, sealed
-- like a model key and bound to merchant_id and the agent id.
CREATE TABLE agents (
  id                    TEXT PRIMARY KEY,              -- agt_...
  merchant_id           TEXT NOT NULL REFERENCES merchants (id),
  kind                  TEXT NOT NULL CHECK (kind IN ('ops', 'skill')),
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  connection_id         TEXT NOT NULL REFERENCES ai_connections (id),
  model                 TEXT NOT NULL,
  instructions          TEXT NOT NULL DEFAULT '',
  tools                 TEXT,                          -- ops: JSON array of allowed tools; NULL = all of them
  max_turns             INTEGER NOT NULL,
  max_output_tokens     INTEGER NOT NULL,
  timeout_seconds       INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  slug                  TEXT,                          -- skill only
  price                 TEXT,                          -- skill only, token base units
  input_hint            TEXT,                          -- skill only
  provider_id           TEXT REFERENCES providers (id),
  provider_key_ciphertext TEXT,
  provider_key_iv       TEXT,
  provider_key_tag      TEXT,
  provider_key_version  INTEGER,
  created_at            TEXT NOT NULL,
  created_by            TEXT,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  CHECK ((kind = 'skill') = (slug IS NOT NULL AND price IS NOT NULL))
);
CREATE INDEX agents_merchant ON agents (merchant_id, created_at);
CREATE INDEX agents_connection ON agents (connection_id);
CREATE UNIQUE INDEX agents_slug ON agents (slug) WHERE slug IS NOT NULL AND deleted_at IS NULL;

-- One piece of work. The worker claims a queued run whose next_attempt_ms has passed (agent_runs_claim), holds it
-- under a lease it renews, and writes every step to agent_run_events.
CREATE TABLE agent_runs (
  id                 TEXT PRIMARY KEY,                 -- run_...
  agent_id           TEXT NOT NULL REFERENCES agents (id),
  merchant_id        TEXT NOT NULL REFERENCES merchants (id),
  connection_id      TEXT NOT NULL REFERENCES ai_connections (id),
  trigger            TEXT NOT NULL CHECK (trigger IN ('dashboard', 'api', 'skill_call')),
  input              TEXT NOT NULL,                    -- untrusted text
  status             TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  attempt            INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 3,
  next_attempt_ms    INTEGER NOT NULL,
  lease_owner        TEXT,
  lease_expires_ms   INTEGER,
  cancel_requested   INTEGER NOT NULL DEFAULT 0,
  result             TEXT,                             -- JSON {answer, data?}
  error_code         TEXT,
  error_message      TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,       -- across every attempt
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  model              TEXT,
  provider           TEXT,
  idempotency_key    TEXT,
  result_token_hash  TEXT,                             -- skill callers: sha256 of the result token
  skill_call_id      TEXT,                             -- skill callers: the clearing receipt of the paid call
  payer              TEXT,                             -- skill callers: the paying agent wallet
  created_by         TEXT,                             -- user or API key id
  created_ms         INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  updated_at         TEXT NOT NULL
);
CREATE INDEX agent_runs_claim ON agent_runs (status, next_attempt_ms, created_ms);
CREATE INDEX agent_runs_lease ON agent_runs (status, lease_expires_ms);
CREATE INDEX agent_runs_merchant ON agent_runs (merchant_id, status);
CREATE INDEX agent_runs_agent ON agent_runs (agent_id, created_ms);
CREATE INDEX agent_runs_usage ON agent_runs (connection_id, created_ms);
CREATE UNIQUE INDEX agent_runs_idempotency ON agent_runs (merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Steps of a run, numbered per run: started, model_turn, tool_call, tool_result, retry_scheduled, finished.
CREATE TABLE agent_run_events (
  run_id   TEXT NOT NULL REFERENCES agent_runs (id),
  seq      INTEGER NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('started', 'model_turn', 'tool_call', 'tool_result', 'retry_scheduled', 'finished')),
  attempt  INTEGER NOT NULL,
  data     TEXT NOT NULL,                              -- JSON; tool inputs and short result summaries, never keys
  at       TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Run-scoped API keys: an ops run reads payments and requests refunds through a key narrowed to those permissions,
-- revoked when the attempt ends and expiring on its own. Such keys are not listed under Developers > API keys.
ALTER TABLE api_keys ADD COLUMN permissions TEXT;    -- JSON array narrowing the key; NULL = every API key permission
ALTER TABLE api_keys ADD COLUMN agent_run_id TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
