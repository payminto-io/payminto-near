-- Payminto on NEAR: the complete schema, one file. No production data exists for this product, so earlier migrations
-- were squashed here. Startup refuses a database with older migration entries and never drops one (src/db/database.ts).
--
-- Amounts are decimal TEXT of token atomic units. Accounts are NEAR account ids, 32-byte ids are lowercase hex.
-- *_at columns are ISO-8601 UTC text, `timestamp` columns are unix seconds, *_ms columns are unix milliseconds.

CREATE TABLE budgets (
  id             TEXT PRIMARY KEY,           -- budget id: sha256(borsh(terms)), see packages/chain
  owner          TEXT NOT NULL,              -- the NEAR account that opened it and funds its escrow
  agent          TEXT NOT NULL,              -- the agent's ed25519 public key, ed25519:<base58>
  settler        TEXT NOT NULL,              -- the only account allowed to settle this Budget
  cap            TEXT NOT NULL,              -- gross authority; deposits never raise it
  valid_until_ms INTEGER NOT NULL,
  policy_hash    TEXT NOT NULL,
  salt           TEXT NOT NULL,
  policy         TEXT NOT NULL,              -- canonical policy JSON
  payees         TEXT NOT NULL,              -- JSON array of account ids, empty = any payee
  label          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'open', 'revoked')),
  open_tx_hash   TEXT,
  revoked_at     TEXT,
  revoked_by     TEXT,
  revoke_tx_hash TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX budgets_agent ON budgets (agent);
CREATE INDEX budgets_owner ON budgets (owner);
CREATE INDEX budgets_status ON budgets (status);

-- Last known on-chain funding of a Budget: escrow, and the owner's withdrawable credit (incoming from confirmed batches).
CREATE TABLE budget_funds (
  budget_id    TEXT PRIMARY KEY REFERENCES budgets (id),
  escrow       TEXT NOT NULL,
  credit       TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL              -- unix milliseconds
);

-- status: building (never sent), submitted (sent, no answer yet), confirmed (the hub has it), failed (the hub refused it
-- or it was never sent), unknown (the send failed without a verdict; its calls went back to the queue and the batch is
-- adopted if the hub turns out to have it).
CREATE TABLE batches (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        TEXT UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('building', 'submitted', 'confirmed', 'failed', 'unknown')),
  token           TEXT NOT NULL,
  receipts_root   TEXT,
  claims          INTEGER NOT NULL DEFAULT 0,
  calls           INTEGER NOT NULL DEFAULT 0,
  gross           TEXT NOT NULL DEFAULT '0',
  net             TEXT NOT NULL DEFAULT '0',
  transfers       INTEGER NOT NULL DEFAULT 0,
  projected_gross TEXT NOT NULL DEFAULT '0',
  projected_net   TEXT NOT NULL DEFAULT '0',
  reconciled      INTEGER,
  tx_hash         TEXT,
  error           TEXT,
  trigger         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  submitted_at    TEXT,
  confirmed_at    TEXT
);
CREATE INDEX batches_status ON batches (status);

CREATE TABLE batch_claims (
  batch_seq       INTEGER NOT NULL REFERENCES batches (seq),
  idx             INTEGER NOT NULL,
  budget_id       TEXT NOT NULL REFERENCES budgets (id),
  agent           TEXT NOT NULL,
  payee           TEXT NOT NULL,
  cumulative      TEXT NOT NULL,
  previous        TEXT NOT NULL,             -- settled cumulative before this batch
  delta           TEXT NOT NULL,
  amount          TEXT NOT NULL,             -- amount of the latest voucher, which the signature binds
  request_hash    TEXT NOT NULL,             -- request of the latest voucher, which the signature binds
  calls           INTEGER NOT NULL,
  agent_signature TEXT NOT NULL,
  PRIMARY KEY (batch_seq, idx)
);

-- The canonical netting result sent as expected_net: one row per party with a non-zero position.
CREATE TABLE batch_net (
  batch_seq INTEGER NOT NULL REFERENCES batches (seq),
  account   TEXT NOT NULL,
  debit     TEXT NOT NULL,
  credit    TEXT NOT NULL,
  PRIMARY KEY (batch_seq, account)
);

-- Display only: one possible debtor-to-creditor matching of the net result. Cash on chain moves through escrow and credits.
CREATE TABLE net_transfers (
  batch_seq INTEGER NOT NULL REFERENCES batches (seq),
  idx       INTEGER NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr   TEXT NOT NULL,
  amount    TEXT NOT NULL,
  PRIMARY KEY (batch_seq, idx)
);

-- Accounts the node pays out hub credit to: net creditors of its batches and checkout merchants. The hub's `payout`
-- zeroes credit before the transfer and restores it if the transfer fails, so a payout is safe to repeat.
CREATE TABLE payout_accounts (
  account           TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('due', 'waiting_registration', 'clear')),
  credit            TEXT NOT NULL DEFAULT '0',  -- last credit read from the hub
  attempts          INTEGER NOT NULL DEFAULT 0, -- failed payouts in a row
  next_attempt_unix INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  checked_at        TEXT,
  paid_total        TEXT NOT NULL DEFAULT '0',
  updated_at        TEXT NOT NULL
);
CREATE INDEX payout_accounts_due ON payout_accounts (status, next_attempt_unix);

-- One `payout` call of at most 10 accounts. unknown: the call failed without a verdict (the next run reads credit again).
CREATE TABLE payouts (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed', 'unknown')),
  trigger      TEXT NOT NULL,
  tx_hash      TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);

-- Credit before and after the call, read from the hub. paid = before - after when the credit went to zero.
CREATE TABLE payout_items (
  payout_seq    INTEGER NOT NULL REFERENCES payouts (seq),
  account       TEXT NOT NULL,
  credit_before TEXT NOT NULL,
  credit_after  TEXT,
  paid          TEXT NOT NULL DEFAULT '0',
  outcome       TEXT NOT NULL CHECK (outcome IN ('pending', 'paid', 'kept')),
  PRIMARY KEY (payout_seq, account)
);
CREATE INDEX payout_items_account ON payout_items (account);

-- Any-chain checkout quotes. Mainnet only, and simulated on a testnet node.
CREATE TABLE oneclick_quotes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id     TEXT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  origin_asset   TEXT NOT NULL,
  amount_in      TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  deposit_memo   TEXT,
  simulated      INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL CHECK (status IN ('quoted', 'deposited', 'succeeded', 'failed', 'expired')),
  deadline_unix  INTEGER NOT NULL,
  raw_response   TEXT NOT NULL,              -- JSON, for support
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX oneclick_quotes_payment ON oneclick_quotes (payment_id, status);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

CREATE TABLE positions (
  budget_id  TEXT NOT NULL REFERENCES budgets (id),
  payee       TEXT NOT NULL,
  cumulative  TEXT NOT NULL,                   -- latest accepted cumulative
  settled     TEXT NOT NULL,                   -- cumulative already settled on chain by this node
  PRIMARY KEY (budget_id, payee)
);

CREATE TABLE calls (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id         TEXT NOT NULL UNIQUE,
  budget_id      TEXT NOT NULL REFERENCES budgets (id),
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
  UNIQUE (budget_id, payee, cumulative)
);

CREATE INDEX calls_budget_time ON calls (budget_id, timestamp);

CREATE INDEX calls_status ON calls (status);

CREATE INDEX calls_batch ON calls (batch_seq);

CREATE INDEX calls_provider_time ON calls (provider_id, timestamp);

CREATE INDEX calls_agent ON calls (agent, status);

CREATE TABLE denials (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  rule         TEXT NOT NULL,
  message      TEXT NOT NULL,
  budget_id   TEXT NOT NULL,                  -- not a foreign key: UNKNOWN_BUDGET denials reference unknown ids
  agent        TEXT,
  payee        TEXT NOT NULL,
  provider_id  TEXT NOT NULL,
  amount       TEXT NOT NULL,
  cumulative   TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  details      TEXT NOT NULL,                  -- JSON
  timestamp    INTEGER NOT NULL,
  at           TEXT NOT NULL
, repeats INTEGER NOT NULL DEFAULT 1, last_seen INTEGER);

CREATE INDEX denials_time ON denials (timestamp);

CREATE INDEX denials_budget ON denials (budget_id);

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

CREATE TABLE events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL,                      -- JSON entity in its API shape
  at       TEXT NOT NULL
);

CREATE INDEX denials_dedup ON denials (budget_id, request_hash, cumulative);

CREATE TABLE fee_plans (
  id                 TEXT PRIMARY KEY,          -- fp_...
  name               TEXT NOT NULL,
  platform_fee_bps   INTEGER NOT NULL CHECK (platform_fee_bps BETWEEN 0 AND 1000),
  platform_fee_fixed TEXT NOT NULL DEFAULT '0',
  min_fee            TEXT NOT NULL DEFAULT '0',
  max_fee            TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE platform (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  name                TEXT NOT NULL,
  fee_recipient       TEXT,                     -- from PLATFORM_FEE_ADDRESS; required when any fee is non-zero
  default_fee_plan_id TEXT NOT NULL REFERENCES fee_plans (id),
  updated_at          TEXT NOT NULL
, signup_mode TEXT NOT NULL DEFAULT 'off' CHECK (signup_mode IN ('off', 'approval', 'open')), require_2fa_platform INTEGER NOT NULL DEFAULT 0, agent_budgets_for_businesses INTEGER NOT NULL DEFAULT 0);

CREATE TABLE merchants (
  id            TEXT PRIMARY KEY,               -- mer_...
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  payout        TEXT,                           -- NEAR account checkout payments credit; NULL until proven (payout_set = 0)
  support_email TEXT,
  brand_color   TEXT,
  logo_url      TEXT,
  fee_plan_id   TEXT NOT NULL REFERENCES fee_plans (id),
  provider_id   TEXT REFERENCES providers (id), -- clearing provider record with payee = payout, for vouchers
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
, payout_set INTEGER NOT NULL DEFAULT 1);

CREATE TABLE merchant_payout_changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  old_payout  TEXT,
  new_payout  TEXT NOT NULL,
  signature   TEXT,                             -- NEP-413 signature (base64); NULL for the seed payout from GATEWAY_PAYOUT_ACCOUNT
  public_key  TEXT,                             -- the full-access key of new_payout that signed it
  signed_at   INTEGER,
  at          TEXT NOT NULL
);

CREATE TABLE payment_links (
  id            TEXT PRIMARY KEY,               -- plink_...
  merchant_id   TEXT NOT NULL REFERENCES merchants (id),
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT,
  amount        TEXT,                           -- fixed amount, or NULL when the payer chooses
  min_amount    TEXT,
  max_amount    TEXT,
  collect_email INTEGER NOT NULL DEFAULT 0,
  collect_name  INTEGER NOT NULL DEFAULT 0,
  success_url   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  listed        INTEGER NOT NULL DEFAULT 1,     -- shown in the service directory
  max_payments  INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
, expires_at TEXT, created_by TEXT);

-- Money toward a payment. wallet: the hub recorded the checkout payment id (one per payment). voucher: an accepted
-- clearing call, confirmed when its batch settles. 'oneclick' is reserved for the add-ons layer's any-chain rail.
CREATE TABLE payment_credits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id     TEXT NOT NULL REFERENCES payments (id),
  method         TEXT NOT NULL CHECK (method IN ('wallet', 'voucher', 'oneclick')),
  payer          TEXT,                          -- NEAR account: the wallet that paid, or the Budget owner of a voucher
  amount         TEXT NOT NULL,
  tx_hash        TEXT,                          -- wallet: reported by the payer's wallet; voucher: the batch transaction
  checkout_id    TEXT UNIQUE,                   -- wallet credits: the hub's payment id
  recorded_at_ms INTEGER,                       -- wallet credits: hub block time
  call_id        TEXT UNIQUE,                   -- voucher credits: the accepted clearing call
  batch_id       TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  late           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  confirmed_at   TEXT
);

CREATE INDEX payment_credits_payment ON payment_credits (payment_id);

CREATE INDEX payment_credits_status ON payment_credits (status, method);

CREATE TABLE refunds (
  id             TEXT PRIMARY KEY,              -- re_...
  merchant_id    TEXT NOT NULL REFERENCES merchants (id),
  payment_id     TEXT NOT NULL REFERENCES payments (id),
  amount         TEXT NOT NULL,
  reason         TEXT,
  to_addr        TEXT NOT NULL,                 -- NEAR account the merchant refunds
  status         TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  method         TEXT CHECK (method IN ('transfer')),
  tx_hash        TEXT UNIQUE,                   -- the merchant's own ft_transfer, sent from its payout account
  verification   TEXT CHECK (verification IN ('transfer_checked', 'finality_only')),
  submitted_unix INTEGER,
  failure_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
, note TEXT, approval TEXT NOT NULL DEFAULT 'not_required' CHECK (approval IN ('not_required', 'requested', 'approved')), requested_by TEXT, approved_by TEXT, approved_at TEXT);

CREATE INDEX refunds_payment ON refunds (payment_id);

CREATE INDEX refunds_status ON refunds (status);

-- merchant_id NULL is a platform endpoint: clearing alerts such as budget.refused, managed by platform roles.
CREATE TABLE webhook_endpoints (
  id          TEXT PRIMARY KEY,                 -- we_...
  merchant_id TEXT REFERENCES merchants (id),
  url         TEXT NOT NULL,
  description TEXT,
  events      TEXT NOT NULL,                    -- JSON array of event types, or ["*"]
  active      INTEGER NOT NULL DEFAULT 1,
  secret      TEXT NOT NULL,                    -- whsec_...; the HMAC key, so it is stored as is
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                              -- soft delete keeps the delivery log readable
, failing_since INTEGER, disabled_reason TEXT);

CREATE TABLE gateway_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,             -- evt_...
  merchant_id TEXT REFERENCES merchants (id),   -- NULL for platform events
  type        TEXT NOT NULL,
  object_id   TEXT NOT NULL,                    -- payment, refund or endpoint id
  payment_id  TEXT,                             -- for the payment timeline (refund events carry it too)
  body        TEXT NOT NULL,                    -- the exact JSON envelope sent to endpoints
  created     INTEGER NOT NULL,                 -- unix seconds, as in the envelope
  created_at  TEXT NOT NULL
);

CREATE INDEX gateway_events_payment ON gateway_events (payment_id, seq);

CREATE TABLE webhook_deliveries (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,         -- whd_...
  event_id        TEXT NOT NULL REFERENCES gateway_events (id),
  endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints (id),
  url             TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  manual          INTEGER NOT NULL DEFAULT 0,   -- a manual retry does not continue the schedule
  status          TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  scheduled_unix  INTEGER NOT NULL,
  response_status INTEGER,
  response_body   TEXT,
  duration_ms     INTEGER,
  error           TEXT,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL,
  attempted_at    TEXT
);

CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, scheduled_unix);

CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, seq);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,                -- key_...
  merchant_id  TEXT NOT NULL REFERENCES merchants (id),
  name         TEXT,
  livemode     INTEGER NOT NULL,
  prefix       TEXT NOT NULL,
  secret_hash  TEXT NOT NULL UNIQUE,            -- sha256 of the secret; the secret itself is never stored
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
, permissions TEXT, agent_run_id TEXT, expires_at TEXT);

CREATE TABLE idempotency_keys (
  scope        TEXT NOT NULL,                   -- merchant and route, e.g. "mer_... POST /v1/payments"
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INTEGER,                         -- NULL while the first request is still running
  response     TEXT,
  created_unix INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX idempotency_keys_created ON idempotency_keys (created_unix);

CREATE TABLE screening_deny_list (
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  address     TEXT NOT NULL,                    -- the blocked payer's NEAR account id
  reason      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (merchant_id, address)
);

CREATE TABLE screening_decisions (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,              -- scr_...
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  rule       TEXT NOT NULL CHECK (rule IN ('PAYER_DENIED')),
  message    TEXT NOT NULL,
  stage      TEXT NOT NULL,                     -- voucher (refused before acceptance) or wallet (recorded after the hub took it)
  payer      TEXT,
  payout     TEXT NOT NULL,
  payment_id TEXT,
  link_id    TEXT,
  amount     TEXT,
  details    TEXT NOT NULL DEFAULT '{}',
  timestamp  INTEGER NOT NULL,
  at         TEXT NOT NULL
);

CREATE INDEX screening_decisions_time ON screening_decisions (timestamp);

CREATE TABLE users (
  id                TEXT PRIMARY KEY,                  -- usr_...
  email             TEXT NOT NULL UNIQUE,              -- lowercased
  email_verified_at TEXT,
  name              TEXT NOT NULL DEFAULT '',
  password_hash     TEXT,                              -- scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>
  totp_secret_enc   TEXT,                              -- reserved for two-step verification
  platform_role     TEXT CHECK (platform_role IN ('owner', 'admin')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'disabled')),
  failed_logins     INTEGER NOT NULL DEFAULT 0,        -- failures in the current window
  first_failed_unix INTEGER,                           -- start of the current failure window
  lock_count        INTEGER NOT NULL DEFAULT 0,        -- locks so far; each doubles the next lock
  locked_until_unix INTEGER,
  last_business_id  TEXT REFERENCES merchants (id),
  last_active_at    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX users_one_owner ON users (platform_role) WHERE platform_role = 'owner';

CREATE TABLE memberships (
  user_id     TEXT NOT NULL REFERENCES users (id),
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  role        TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, merchant_id)
);

CREATE INDEX memberships_merchant ON memberships (merchant_id);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,                  -- ses_..., public handle for the sessions list
  id_hash           TEXT NOT NULL UNIQUE,              -- sha256 of the cookie token; the token itself is never stored
  user_id           TEXT NOT NULL REFERENCES users (id),
  csrf_token        TEXT NOT NULL,
  created_unix      INTEGER NOT NULL,
  last_seen_unix    INTEGER NOT NULL,
  expires_unix      INTEGER NOT NULL,                  -- absolute expiry
  idle_expires_unix INTEGER NOT NULL,
  step_up_unix      INTEGER,                           -- last password check
  rotated_from      TEXT,
  revoked_unix      INTEGER,                           -- set in the future (grace) when rotated
  rotate_due        INTEGER NOT NULL DEFAULT 0,        -- 1 after a role or password change: the next request rotates
  ip                TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE auth_tokens (
  id           TEXT PRIMARY KEY,                       -- inv_... for invites, tok_... otherwise
  token_hash   TEXT NOT NULL UNIQUE,                   -- sha256 of the token
  kind         TEXT NOT NULL CHECK (kind IN ('verify_email', 'reset_password', 'invite', 'setup')),
  user_id      TEXT REFERENCES users (id),
  email        TEXT,
  merchant_id  TEXT REFERENCES merchants (id),
  role         TEXT,                                   -- invites: admin, staff, viewer or platform_admin
  expires_unix INTEGER NOT NULL,
  used_at      TEXT,
  revoked_at   TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX auth_tokens_kind ON auth_tokens (kind, merchant_id);

CREATE INDEX auth_tokens_email ON auth_tokens (email);

CREATE TABLE outbox_emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body_text  TEXT NOT NULL,
  link       TEXT,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  error      TEXT
);

CREATE TABLE audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  at_unix     INTEGER NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'recovery_key', 'system')),
  actor_id    TEXT,
  merchant_id TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  ip          TEXT,
  meta_json   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_events_merchant ON audit_events (merchant_id, id);

CREATE INDEX audit_events_actor ON audit_events (actor_id, id);

CREATE INDEX audit_events_action ON audit_events (action, id);

CREATE TRIGGER audit_events_append_only BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_keep_a_year BEFORE DELETE ON audit_events
WHEN old.at_unix > CAST(strftime('%s', 'now') AS INTEGER) - 31536000
BEGIN
  SELECT RAISE(ABORT, 'audit_events younger than one year cannot be deleted');
END;

CREATE TABLE signup_requests (
  id            TEXT PRIMARY KEY,                      -- sur_...
  user_id       TEXT NOT NULL REFERENCES users (id),
  business_name TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('unverified', 'pending', 'approved', 'declined')),
  reason        TEXT,
  merchant_id   TEXT REFERENCES merchants (id),
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT
);

CREATE INDEX signup_requests_status ON signup_requests (status, created_at);

CREATE TABLE search_recent (
  user_id TEXT NOT NULL REFERENCES users (id),
  type    TEXT NOT NULL,
  id      TEXT NOT NULL,
  title   TEXT NOT NULL,
  href    TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (user_id, type, id)
);

CREATE INDEX payment_credits_payer_lc ON payment_credits (lower(payer));

CREATE INDEX payment_credits_tx_lc ON payment_credits (lower(tx_hash));

CREATE INDEX refunds_tx_lc ON refunds (lower(tx_hash));

CREATE INDEX refunds_to_lc ON refunds (lower(to_addr));

CREATE INDEX refunds_merchant ON refunds (merchant_id);

CREATE INDEX merchants_payout_lc ON merchants (lower(payout));

CREATE INDEX payment_links_merchant ON payment_links (merchant_id);

CREATE VIRTUAL TABLE payments_fts USING fts5(description, reference, customer_email, customer_name, content = 'payments', content_rowid = 'rowid', tokenize = 'unicode61')
;

CREATE VIRTUAL TABLE payment_links_fts USING fts5(title, description, slug, content = 'payment_links', content_rowid = 'rowid', tokenize = 'unicode61')
;

CREATE TRIGGER payment_links_fts_ai AFTER INSERT ON payment_links BEGIN
  INSERT INTO payment_links_fts (rowid, title, description, slug) VALUES (new.rowid, new.title, new.description, new.slug);
END;

CREATE TRIGGER payment_links_fts_ad AFTER DELETE ON payment_links BEGIN
  INSERT INTO payment_links_fts (payment_links_fts, rowid, title, description, slug) VALUES ('delete', old.rowid, old.title, old.description, old.slug);
END;

CREATE TRIGGER payment_links_fts_au AFTER UPDATE OF title, description, slug ON payment_links BEGIN
  INSERT INTO payment_links_fts (payment_links_fts, rowid, title, description, slug) VALUES ('delete', old.rowid, old.title, old.description, old.slug);
  INSERT INTO payment_links_fts (rowid, title, description, slug) VALUES (new.rowid, new.title, new.description, new.slug);
END;

CREATE VIRTUAL TABLE merchants_fts USING fts5(name, slug, support_email, content = 'merchants', content_rowid = 'rowid', tokenize = 'unicode61')
;

CREATE TRIGGER merchants_fts_ai AFTER INSERT ON merchants BEGIN
  INSERT INTO merchants_fts (rowid, name, slug, support_email) VALUES (new.rowid, new.name, new.slug, new.support_email);
END;

CREATE TRIGGER merchants_fts_ad AFTER DELETE ON merchants BEGIN
  INSERT INTO merchants_fts (merchants_fts, rowid, name, slug, support_email) VALUES ('delete', old.rowid, old.name, old.slug, old.support_email);
END;

CREATE TRIGGER merchants_fts_au AFTER UPDATE OF name, slug, support_email ON merchants BEGIN
  INSERT INTO merchants_fts (merchants_fts, rowid, name, slug, support_email) VALUES ('delete', old.rowid, old.name, old.slug, old.support_email);
  INSERT INTO merchants_fts (rowid, name, slug, support_email) VALUES (new.rowid, new.name, new.slug, new.support_email);
END;

CREATE TABLE merchant_methods (
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  method      TEXT NOT NULL CHECK (method IN ('wallet', 'voucher', 'oneclick')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  fee_bps     INTEGER NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 1000),
  fee_fixed   TEXT NOT NULL DEFAULT '0',
  bearer      TEXT NOT NULL DEFAULT 'merchant' CHECK (bearer IN ('merchant', 'customer')),
  min_amount  TEXT,
  max_amount  TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (merchant_id, method)
);

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,             -- pay_...
  merchant_id     TEXT NOT NULL REFERENCES merchants (id),
  status          TEXT NOT NULL CHECK (status IN ('open', 'processing', 'partially_paid', 'paid', 'overpaid', 'underpaid', 'expired', 'canceled')),
  amount          TEXT NOT NULL,                -- merchant price
  quote_method    TEXT CHECK (quote_method IN ('wallet', 'voucher', 'oneclick')),
  surcharge       TEXT NOT NULL DEFAULT '0',    -- method fee the customer bears
  amount_due      TEXT NOT NULL,                -- amount + surcharge
  platform_fee    TEXT NOT NULL DEFAULT '0',
  method_fee      TEXT NOT NULL DEFAULT '0',
  fee_total       TEXT NOT NULL DEFAULT '0',
  net_amount      TEXT NOT NULL,                -- amount_due - fee_total
  fee_recipient   TEXT,
  amount_paid     TEXT NOT NULL DEFAULT '0',    -- sum of confirmed credits, written with the status
  amount_refunded TEXT NOT NULL DEFAULT '0',    -- sum of succeeded refunds
  checkout_id     TEXT NOT NULL UNIQUE,         -- the hub's payment id in the node-signed checkout terms (32 random bytes)
  payout          TEXT NOT NULL,                -- the merchant account fixed at creation; the checkout terms credit it
  description     TEXT,
  reference       TEXT,
  customer_email  TEXT,
  customer_name   TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  line_items      TEXT NOT NULL DEFAULT '[]',
  order_hash      TEXT NOT NULL,                -- sha256 of the canonical order JSON
  link_id         TEXT REFERENCES payment_links (id),
  payer           TEXT,
  method          TEXT,
  late            INTEGER NOT NULL DEFAULT 0,
  success_url     TEXT,
  wallet_tx_hash  TEXT,                         -- the transaction the payer's wallet reported; display only
  expires_at      TEXT NOT NULL,
  expires_unix    INTEGER NOT NULL,
  paid_at         TEXT,
  canceled_at     TEXT,
  closed_at       TEXT,                         -- when it first became terminal; the payment watcher keeps polling it a while
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  draft           INTEGER NOT NULL DEFAULT 0,
  draft_key       TEXT                          -- sha256(link id, client IP, User-Agent)
);

CREATE INDEX payments_merchant ON payments (merchant_id, created_at);

CREATE INDEX payments_status ON payments (status, expires_unix);

CREATE INDEX payments_created ON payments (created_at);

CREATE INDEX payments_link ON payments (link_id);

CREATE INDEX payments_draft ON payments (draft, draft_key);

CREATE INDEX payments_payer_lc ON payments (lower(payer));

CREATE INDEX payments_email_lc ON payments (lower(customer_email));

CREATE INDEX payments_reference ON payments (reference);

CREATE INDEX payments_merchant_amount ON payments (merchant_id, amount);

CREATE TRIGGER payments_fts_ai AFTER INSERT ON payments BEGIN
  INSERT INTO payments_fts (rowid, description, reference, customer_email, customer_name) VALUES (new.rowid, new.description, new.reference, new.customer_email, new.customer_name);
END;

CREATE TRIGGER payments_fts_ad AFTER DELETE ON payments BEGIN
  INSERT INTO payments_fts (payments_fts, rowid, description, reference, customer_email, customer_name) VALUES ('delete', old.rowid, old.description, old.reference, old.customer_email, old.customer_name);
END;

CREATE TRIGGER payments_fts_au AFTER UPDATE OF description, reference, customer_email, customer_name ON payments BEGIN
  INSERT INTO payments_fts (payments_fts, rowid, description, reference, customer_email, customer_name) VALUES ('delete', old.rowid, old.description, old.reference, old.customer_email, old.customer_name);
  INSERT INTO payments_fts (rowid, description, reference, customer_email, customer_name) VALUES (new.rowid, new.description, new.reference, new.customer_email, new.customer_name);
END;

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

CREATE TABLE agent_run_events (
  run_id   TEXT NOT NULL REFERENCES agent_runs (id),
  seq      INTEGER NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('started', 'model_turn', 'tool_call', 'tool_result', 'retry_scheduled', 'finished')),
  attempt  INTEGER NOT NULL,
  data     TEXT NOT NULL,                              -- JSON; tool inputs and short result summaries, never keys
  at       TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE ai_connections (
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

CREATE INDEX ai_connections_merchant ON ai_connections (merchant_id, created_at);

-- Zero-fee plan: the operator take rate is roadmap, and fee_plans stays so the schema can carry one later.
INSERT INTO fee_plans (id, name, platform_fee_bps, platform_fee_fixed, min_fee, max_fee, created_at, updated_at)
VALUES ('fp_zero', 'No fee', 0, '0', '0', NULL, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
