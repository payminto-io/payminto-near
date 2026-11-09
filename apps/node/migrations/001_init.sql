-- Payminto Clearing Node schema v1.
-- Amounts are decimal TEXT of token atomic units; code handles them as bigint. Never floats.
-- Times: *_at columns are ISO-8601 UTC text; `timestamp` columns are unix seconds (integers).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE mandates (
  id              TEXT PRIMARY KEY,           -- EIP-712 mandate digest
  owner           TEXT NOT NULL,
  agent           TEXT NOT NULL,
  token           TEXT NOT NULL,
  total_cap       TEXT NOT NULL,
  valid_after     INTEGER NOT NULL,
  valid_until     INTEGER NOT NULL,
  payees_root     TEXT NOT NULL,
  policy_hash     TEXT NOT NULL,
  salt            TEXT NOT NULL,
  owner_signature TEXT NOT NULL,
  policy          TEXT NOT NULL,              -- canonical policy JSON
  payees          TEXT NOT NULL,              -- JSON array of checksummed addresses, empty = any payee
  label           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'open', 'revoked')),
  open_tx_hash    TEXT,
  revoked_at      TEXT,
  revoked_by      TEXT,
  revoke_tx_hash  TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX mandates_agent ON mandates (agent);
CREATE INDEX mandates_status ON mandates (status);

CREATE TABLE providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  payee         TEXT NOT NULL,
  price_atomic  TEXT NOT NULL,
  resource      TEXT NOT NULL,
  category      TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL UNIQUE,          -- sha256 hex of the API key; the key itself is never stored
  created_at    TEXT NOT NULL
);
CREATE INDEX providers_payee ON providers (payee);

-- Latest accepted voucher position per (mandate, payee).
CREATE TABLE positions (
  mandate_id  TEXT NOT NULL REFERENCES mandates (id),
  payee       TEXT NOT NULL,
  cumulative  TEXT NOT NULL,                   -- latest accepted cumulative
  settled     TEXT NOT NULL,                   -- cumulative already settled on chain by this node
  PRIMARY KEY (mandate_id, payee)
);

CREATE TABLE calls (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id         TEXT NOT NULL UNIQUE,
  mandate_id      TEXT NOT NULL REFERENCES mandates (id),
  agent           TEXT NOT NULL,
  payee           TEXT NOT NULL,
  provider_id     TEXT NOT NULL REFERENCES providers (id),
  amount          TEXT NOT NULL,
  cumulative      TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  agent_signature TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,
  leaf            TEXT NOT NULL,
  node_signature  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('accepted', 'settling', 'settled')),
  batch_seq       INTEGER REFERENCES batches (seq),
  proof           TEXT,                        -- JSON array of bytes32, set when batched
  accepted_at     TEXT NOT NULL,
  UNIQUE (mandate_id, payee, cumulative)
);
CREATE INDEX calls_mandate_time ON calls (mandate_id, timestamp);
CREATE INDEX calls_status ON calls (status);
CREATE INDEX calls_batch ON calls (batch_seq);
CREATE INDEX calls_provider_time ON calls (provider_id, timestamp);
CREATE INDEX calls_agent ON calls (agent, status);

CREATE TABLE denials (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  rule         TEXT NOT NULL,
  message      TEXT NOT NULL,
  mandate_id   TEXT NOT NULL,                  -- not a foreign key: UNKNOWN_MANDATE denials reference unknown ids
  agent        TEXT,
  payee        TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  amount       TEXT NOT NULL,
  cumulative   TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  details      TEXT NOT NULL,                  -- JSON
  timestamp    INTEGER NOT NULL,
  at           TEXT NOT NULL
);
CREATE INDEX denials_time ON denials (timestamp);
CREATE INDEX denials_mandate ON denials (mandate_id);

CREATE TABLE batches (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       TEXT UNIQUE,                  -- keccak256(abi.encode(chainId, hub, receiptsRoot, seq))
  status         TEXT NOT NULL CHECK (status IN ('building', 'cosigning', 'submitted', 'confirmed', 'failed')),
  token          TEXT NOT NULL,
  receipts_root  TEXT,
  claims         INTEGER NOT NULL DEFAULT 0,
  calls          INTEGER NOT NULL DEFAULT 0,
  gross          TEXT NOT NULL DEFAULT '0',
  net            TEXT NOT NULL DEFAULT '0',
  transfers      INTEGER NOT NULL DEFAULT 0,
  projected_gross TEXT NOT NULL DEFAULT '0',
  projected_net   TEXT NOT NULL DEFAULT '0',
  reconciled     INTEGER,                      -- 1 when on-chain NetTransfer events equal the projection
  tx_hash        TEXT,
  block_number   INTEGER,
  gas_used       TEXT,
  gas_price      TEXT,
  error          TEXT,
  trigger        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  submitted_at   TEXT,
  confirmed_at   TEXT
);
CREATE INDEX batches_status ON batches (status);

CREATE TABLE batch_claims (
  batch_seq   INTEGER NOT NULL REFERENCES batches (seq),
  idx         INTEGER NOT NULL,
  mandate_id  TEXT NOT NULL REFERENCES mandates (id),
  agent       TEXT NOT NULL,
  payee       TEXT NOT NULL,
  cumulative  TEXT NOT NULL,
  previous    TEXT NOT NULL,                   -- settled cumulative before this batch
  delta       TEXT NOT NULL,
  calls       INTEGER NOT NULL,
  agent_signature TEXT NOT NULL,
  payee_proof TEXT NOT NULL,                   -- JSON
  PRIMARY KEY (batch_seq, idx)
);

CREATE TABLE net_transfers (
  batch_seq   INTEGER NOT NULL REFERENCES batches (seq),
  idx         INTEGER NOT NULL,
  from_addr   TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  amount      TEXT NOT NULL,
  log_index   INTEGER,                         -- set from the confirmed NetTransfer event
  PRIMARY KEY (batch_seq, idx)
);

CREATE TABLE hsp_payments (
  id               TEXT PRIMARY KEY,           -- HSP paymentId = EIP-712 hash of the HSP mandate
  batch_seq        INTEGER NOT NULL REFERENCES batches (seq),
  transfer_idx     INTEGER NOT NULL,
  payer            TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  token            TEXT NOT NULL,
  amount           TEXT NOT NULL,
  deadline         INTEGER NOT NULL,
  body             TEXT NOT NULL,              -- HSP wire v1 mandate JSON
  required_caps    TEXT NOT NULL,              -- JSON array
  calls            TEXT NOT NULL,              -- JSON array of the payer's calls in the batch, for co-sign checks
  signer_proof     TEXT,
  status           TEXT NOT NULL CHECK (status IN ('PENDING', 'COSIGNED', 'UNSIGNED', 'SUBMITTED', 'ACCEPT', 'REJECT', 'SETTLED', 'FAILED')),
  satisfied_caps   TEXT,                       -- JSON array
  receipt          TEXT,                       -- JSON adapter receipt
  coordinator_id   TEXT,
  coordinator_status TEXT,
  tx_hash          TEXT,
  log_index        INTEGER,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX hsp_payer_status ON hsp_payments (payer, status);
CREATE INDEX hsp_batch ON hsp_payments (batch_seq);
CREATE INDEX hsp_retry ON hsp_payments (status, next_attempt_at);

CREATE TABLE journals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('call.accepted', 'batch.settled')),
  ref        TEXT NOT NULL,
  memo       TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE TABLE ledger_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id  INTEGER NOT NULL REFERENCES journals (id),
  account     TEXT NOT NULL,
  debit       TEXT NOT NULL,
  credit      TEXT NOT NULL,
  memo        TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX ledger_account ON ledger_entries (account);
CREATE INDEX ledger_journal ON ledger_entries (journal_id);

-- Last known wallet funds per (address, token), refreshed from chain.
CREATE TABLE wallet_funds (
  address      TEXT NOT NULL,
  token        TEXT NOT NULL,
  balance      TEXT NOT NULL,
  allowance    TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL,              -- unix milliseconds
  PRIMARY KEY (address, token)
);

CREATE TABLE events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL,                      -- JSON entity in its API shape
  at       TEXT NOT NULL
);
