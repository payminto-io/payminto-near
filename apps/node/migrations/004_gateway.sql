-- Payminto Gateway (docs/GATEWAY.md): platform, merchants, fee plans, payment methods, payments, credits, links,
-- refunds, webhooks, API keys, idempotency, screening. Every merchant-owned row carries merchant_id.
-- Amounts are decimal TEXT of token base units, summed with bigsum. *_at columns are ISO-8601 UTC text; *_unix columns
-- are unix seconds, kept next to the ISO value where workers compare times.

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
);

CREATE TABLE merchants (
  id            TEXT PRIMARY KEY,               -- mer_...
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  payout        TEXT NOT NULL,
  support_email TEXT,
  brand_color   TEXT,
  logo_url      TEXT,
  fee_plan_id   TEXT NOT NULL REFERENCES fee_plans (id),
  provider_id   TEXT REFERENCES providers (id), -- clearing provider record with payee = payout, for vouchers
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE merchant_methods (
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  method      TEXT NOT NULL CHECK (method IN ('wallet', 'deposit', 'x402', 'voucher')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  fee_bps     INTEGER NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 1000),
  fee_fixed   TEXT NOT NULL DEFAULT '0',
  bearer      TEXT NOT NULL DEFAULT 'merchant' CHECK (bearer IN ('merchant', 'customer')),
  min_amount  TEXT,
  max_amount  TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (merchant_id, method)
);

-- Audit log of payout changes, each proven by an EIP-191 signature of the new payout wallet.
CREATE TABLE merchant_payout_changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  old_payout  TEXT,
  new_payout  TEXT NOT NULL,
  signature   TEXT,                             -- NULL for the seed payout from GATEWAY_PAYOUT_ADDRESS
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
);

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,             -- pay_...
  merchant_id     TEXT NOT NULL REFERENCES merchants (id),
  status          TEXT NOT NULL CHECK (status IN ('open', 'processing', 'partially_paid', 'paid', 'overpaid', 'underpaid', 'expired', 'canceled')),
  amount          TEXT NOT NULL,                -- merchant price
  quote_method    TEXT CHECK (quote_method IN ('wallet', 'deposit', 'x402', 'voucher')),
  surcharge       TEXT NOT NULL DEFAULT '0',    -- method fee the customer bears
  amount_due      TEXT NOT NULL,                -- amount + surcharge
  platform_fee    TEXT NOT NULL DEFAULT '0',
  method_fee      TEXT NOT NULL DEFAULT '0',
  fee_total       TEXT NOT NULL DEFAULT '0',
  net_amount      TEXT NOT NULL,                -- amount_due - fee_total
  fee_recipient   TEXT,
  amount_paid     TEXT NOT NULL DEFAULT '0',    -- sum of confirmed credits, written with the status
  amount_refunded TEXT NOT NULL DEFAULT '0',    -- sum of succeeded refunds
  deposit_address TEXT NOT NULL UNIQUE,         -- DepositForwarder bound to the payout (and fee terms)
  deposit_salt    TEXT NOT NULL,
  payout          TEXT NOT NULL,                -- the payout fixed at creation
  description     TEXT,
  reference       TEXT,
  customer_email  TEXT,
  customer_name   TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  line_items      TEXT NOT NULL DEFAULT '[]',
  order_hash      TEXT NOT NULL,                -- keccak256 of the canonical order JSON
  link_id         TEXT REFERENCES payment_links (id),
  payer           TEXT,
  method          TEXT,
  late            INTEGER NOT NULL DEFAULT 0,
  success_url     TEXT,
  created_block   INTEGER NOT NULL,             -- chain head at creation, where AuthorizationUsed lookups start
  expires_at      TEXT NOT NULL,
  expires_unix    INTEGER NOT NULL,
  paid_at         TEXT,
  canceled_at     TEXT,
  closed_at       TEXT,                         -- when it first became terminal; the deposit watcher keeps it 7 more days
  flush_status    TEXT NOT NULL DEFAULT 'none' CHECK (flush_status IN ('none', 'pending', 'done')),
  flush_attempts  INTEGER NOT NULL DEFAULT 0,
  flush_next_unix INTEGER,
  flush_tx        TEXT,
  flush_error     TEXT,
  attest_status   TEXT NOT NULL DEFAULT 'none' CHECK (attest_status IN ('none', 'pending', 'done')),
  attestation_uid TEXT,                         -- EAS attestation of the confirmed payment (EAS_ATTEST=true)
  attestation_tx  TEXT,
  attest_error    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX payments_merchant ON payments (merchant_id, created_at);
CREATE INDEX payments_status ON payments (status, expires_unix);
CREATE INDEX payments_created ON payments (created_at);
CREATE INDEX payments_link ON payments (link_id);
CREATE INDEX payments_flush ON payments (flush_status, flush_next_unix);

-- One on-chain transfer (or accepted voucher) toward a payment.
CREATE TABLE payment_credits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id   TEXT NOT NULL REFERENCES payments (id),
  method       TEXT NOT NULL CHECK (method IN ('wallet', 'deposit', 'x402', 'voucher')),
  payer        TEXT,
  amount       TEXT NOT NULL,
  tx_hash      TEXT,
  log_index    INTEGER,
  block_number INTEGER,
  block_hash   TEXT,
  call_id      TEXT UNIQUE,                     -- voucher credits: the accepted clearing call
  batch_id     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  late         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  confirmed_at TEXT,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX payment_credits_payment ON payment_credits (payment_id);
CREATE INDEX payment_credits_status ON payment_credits (status, method);

-- EIP-3009 authorizations the node relayed or is relaying, so a crash between broadcast and credit is recovered.
CREATE TABLE payment_relays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  TEXT NOT NULL REFERENCES payments (id),
  method      TEXT NOT NULL CHECK (method IN ('wallet', 'x402')),
  payer       TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  value       TEXT NOT NULL,
  tx_hash     TEXT,
  status      TEXT NOT NULL CHECK (status IN ('sending', 'credited', 'failed')),
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (payer, nonce)
);
CREATE INDEX payment_relays_status ON payment_relays (status);

CREATE TABLE refunds (
  id             TEXT PRIMARY KEY,              -- re_...
  merchant_id    TEXT NOT NULL REFERENCES merchants (id),
  payment_id     TEXT NOT NULL REFERENCES payments (id),
  amount         TEXT NOT NULL,
  reason         TEXT,
  to_addr        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  method         TEXT CHECK (method IN ('authorization', 'transfer')),
  tx_hash        TEXT UNIQUE,
  failure_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX refunds_payment ON refunds (payment_id);
CREATE INDEX refunds_status ON refunds (status);

CREATE TABLE webhook_endpoints (
  id          TEXT PRIMARY KEY,                 -- we_...
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  url         TEXT NOT NULL,
  description TEXT,
  events      TEXT NOT NULL,                    -- JSON array of event types, or ["*"]
  active      INTEGER NOT NULL DEFAULT 1,
  secret      TEXT NOT NULL,                    -- whsec_...; the HMAC key, so it is stored as is
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                              -- soft delete keeps the delivery log readable
);

-- Transactional outbox: written in the same transaction as the state change it describes.
CREATE TABLE gateway_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,             -- evt_...
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  type        TEXT NOT NULL,
  object_id   TEXT NOT NULL,                    -- payment, refund or endpoint id
  payment_id  TEXT,                             -- for the payment timeline (refund events carry it too)
  body        TEXT NOT NULL,                    -- the exact JSON envelope sent to endpoints
  created     INTEGER NOT NULL,                 -- unix seconds, as in the envelope
  created_at  TEXT NOT NULL
);
CREATE INDEX gateway_events_payment ON gateway_events (payment_id, seq);

-- One row per delivery attempt. A 'pending' row is a scheduled attempt; a failed attempt schedules the next row.
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
);

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

-- Deposit watcher cursor: the last block scanned at the finality head.
CREATE TABLE gateway_cursors (
  name  TEXT PRIMARY KEY,
  block INTEGER NOT NULL
);

-- Intake screening (section 13.1): the merchant deny list and every refusal, for the Blocked calls page.
CREATE TABLE screening_deny_list (
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  address     TEXT NOT NULL,                    -- checksummed
  reason      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (merchant_id, address)
);

CREATE TABLE screening_decisions (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,              -- scr_...
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  rule       TEXT NOT NULL CHECK (rule IN ('PAYER_BLACKLISTED', 'PAYOUT_BLACKLISTED', 'PAYER_DENIED', 'PAYER_TOO_NEW')),
  message    TEXT NOT NULL,
  stage      TEXT NOT NULL,                     -- x402, authorize, voucher, checkout
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
