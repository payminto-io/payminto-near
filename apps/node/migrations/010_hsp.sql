-- migrate: foreign-keys-off
-- HSP payment method (docs/GATEWAY.md section 16): HashKey's HSP Agentic Payment into the payment's own forwarder.
-- SQLite cannot change a CHECK constraint in place, so merchant_methods and payments are rebuilt (the documented
-- 12-step procedure, like 003) to accept the method 'hsp'. payments keeps its rowids, which the list cursor and the
-- full-text index are keyed by, and gets its indexes and full-text triggers back.
-- Credits stay 'deposit': an HSP transfer is seen by the deposit watcher like any transfer into the forwarder.

CREATE TABLE merchant_methods_new (
  merchant_id TEXT NOT NULL REFERENCES merchants (id),
  method      TEXT NOT NULL CHECK (method IN ('wallet', 'deposit', 'x402', 'voucher', 'hsp')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  fee_bps     INTEGER NOT NULL DEFAULT 0 CHECK (fee_bps BETWEEN 0 AND 1000),
  fee_fixed   TEXT NOT NULL DEFAULT '0',
  bearer      TEXT NOT NULL DEFAULT 'merchant' CHECK (bearer IN ('merchant', 'customer')),
  min_amount  TEXT,
  max_amount  TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (merchant_id, method)
);
INSERT INTO merchant_methods_new (merchant_id, method, enabled, fee_bps, fee_fixed, bearer, min_amount, max_amount, updated_at)
SELECT merchant_id, method, enabled, fee_bps, fee_fixed, bearer, min_amount, max_amount, updated_at FROM merchant_methods;
DROP TABLE merchant_methods;
ALTER TABLE merchant_methods_new RENAME TO merchant_methods;
-- Every business gets HSP switched off; it is turned on in Settings > Payment methods.
INSERT INTO merchant_methods (merchant_id, method, enabled, updated_at)
SELECT id, 'hsp', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM merchants;

CREATE TABLE payments_new (
  id              TEXT PRIMARY KEY,             -- pay_...
  merchant_id     TEXT NOT NULL REFERENCES merchants (id),
  status          TEXT NOT NULL CHECK (status IN ('open', 'processing', 'partially_paid', 'paid', 'overpaid', 'underpaid', 'expired', 'canceled')),
  amount          TEXT NOT NULL,                -- merchant price
  quote_method    TEXT CHECK (quote_method IN ('wallet', 'deposit', 'x402', 'voucher', 'hsp')),
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
  updated_at      TEXT NOT NULL,
  draft           INTEGER NOT NULL DEFAULT 0,
  draft_key       TEXT,                         -- sha256(link id, client IP, User-Agent)
  -- HSP: one order per payment, reused on every retry; the status is HSP's, the payment state stays the watcher's.
  hsp_flow_id              TEXT UNIQUE,
  hsp_payment_request_id   TEXT,
  hsp_payment_url          TEXT,
  hsp_status               TEXT,                -- order-created, then the query_payment status
  hsp_status_reason        TEXT,
  hsp_tx_hash              TEXT,                -- HSP payment.tx_signature
  hsp_attribution_verified INTEGER NOT NULL DEFAULT 0,
  hsp_payer                TEXT,
  hsp_submitted_at         TEXT,
  hsp_updated_at           TEXT,
  hsp_next_poll_unix       INTEGER              -- when the poller asks query_payment next
);
INSERT INTO payments_new (rowid, id, merchant_id, status, amount, quote_method, surcharge, amount_due, platform_fee, method_fee, fee_total,
                          net_amount, fee_recipient, amount_paid, amount_refunded, deposit_address, deposit_salt, payout, description,
                          reference, customer_email, customer_name, metadata, line_items, order_hash, link_id, payer, method, late,
                          success_url, created_block, expires_at, expires_unix, paid_at, canceled_at, closed_at, flush_status,
                          flush_attempts, flush_next_unix, flush_tx, flush_error, attest_status, attestation_uid, attestation_tx,
                          attest_error, created_at, updated_at, draft, draft_key)
SELECT rowid, id, merchant_id, status, amount, quote_method, surcharge, amount_due, platform_fee, method_fee, fee_total,
       net_amount, fee_recipient, amount_paid, amount_refunded, deposit_address, deposit_salt, payout, description,
       reference, customer_email, customer_name, metadata, line_items, order_hash, link_id, payer, method, late,
       success_url, created_block, expires_at, expires_unix, paid_at, canceled_at, closed_at, flush_status,
       flush_attempts, flush_next_unix, flush_tx, flush_error, attest_status, attestation_uid, attestation_tx,
       attest_error, created_at, updated_at, draft, draft_key
FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE INDEX payments_merchant ON payments (merchant_id, created_at);
CREATE INDEX payments_status ON payments (status, expires_unix);
CREATE INDEX payments_created ON payments (created_at);
CREATE INDEX payments_link ON payments (link_id);
CREATE INDEX payments_flush ON payments (flush_status, flush_next_unix);
CREATE INDEX payments_draft ON payments (draft, draft_key);
CREATE INDEX payments_payer_lc ON payments (lower(payer));
CREATE INDEX payments_email_lc ON payments (lower(customer_email));
CREATE INDEX payments_reference ON payments (reference);
CREATE INDEX payments_merchant_amount ON payments (merchant_id, amount);
CREATE INDEX payments_hsp_poll ON payments (hsp_status, hsp_next_poll_unix);
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
INSERT INTO payments_fts (payments_fts) VALUES ('rebuild');

-- Each prepare_payment quote (valid 5 minutes). A signature is only ever submitted with the quote it was made for:
-- an expired quote is marked expired and the payer prepares and signs again.
CREATE TABLE hsp_quotes (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id               TEXT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  flow_id                  TEXT NOT NULL,
  payer                    TEXT NOT NULL,
  protocol                 TEXT NOT NULL,       -- eip3009 or permit2, from get_chain_config
  pay_to                   TEXT NOT NULL,
  token_total_raw          TEXT NOT NULL,
  cart_hash                TEXT NOT NULL,
  eip712                   TEXT NOT NULL,       -- JSON, exactly what prepare_payment returned
  payment_payload          TEXT NOT NULL,       -- JSON, passed to finalize_payment unchanged
  payment_mandate_contents TEXT NOT NULL,       -- JSON, passed to finalize_payment unchanged
  quote_expires_at         TEXT NOT NULL,
  quote_expires_unix       INTEGER NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('prepared', 'submitting', 'submitted', 'expired', 'failed')),
  signature                TEXT,
  error                    TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX hsp_quotes_payment ON hsp_quotes (payment_id, status);
