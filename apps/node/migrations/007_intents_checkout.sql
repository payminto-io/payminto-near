-- Any-chain checkout through NEAR Intents (1Click): a buyer pays from another chain and the merchant receives exactly the
-- invoice amount of USDC in its own NEAR mainnet account. Additive only: new columns, one new table, new indexes and the
-- `oneclick` method row (off) for every business. The unused oneclick_quotes table from 001 stays as it is.

-- The merchant's NEAR account for any-chain payments: separate from `payout` (a hub account on the node's network).
ALTER TABLE merchants ADD COLUMN intents_payout TEXT;
ALTER TABLE merchants ADD COLUMN intents_payout_proven_at TEXT;
ALTER TABLE merchants ADD COLUMN intents_payout_registered INTEGER NOT NULL DEFAULT 0;
-- The verified NEP-413 proof, as JSON {public_key, signature, timestamp, settlement_network, hub}, for the audit trail.
ALTER TABLE merchants ADD COLUMN intents_payout_proof TEXT;

-- One 1Click quote per row: a payment may have several (the buyer changed token), each with its own deposit address.
CREATE TABLE intents_quotes (
  id                 TEXT PRIMARY KEY,               -- iq_...
  payment_id         TEXT NOT NULL REFERENCES payments (id),
  merchant_id        TEXT NOT NULL REFERENCES merchants (id),
  mode               TEXT NOT NULL CHECK (mode IN ('live', 'simulated')),
  origin_asset       TEXT NOT NULL,
  origin_chain       TEXT NOT NULL,
  origin_symbol      TEXT NOT NULL,
  origin_decimals    INTEGER NOT NULL,
  recipient          TEXT NOT NULL,                  -- the merchant's NEAR account at quote time
  refund_to          TEXT NOT NULL,                  -- buyer data: shown to the merchant only
  slippage_bps       INTEGER NOT NULL,
  amount_out         TEXT NOT NULL,                  -- the invoice amount, USDC base units
  amount_in          TEXT NOT NULL,
  min_amount_in      TEXT NOT NULL,
  amount_in_usd      TEXT,
  refund_fee         TEXT,
  withdraw_fee       TEXT,
  time_estimate_sec  INTEGER NOT NULL,
  deposit_address    TEXT NOT NULL UNIQUE,
  deposit_memo       TEXT,
  deadline_unix      INTEGER NOT NULL,               -- quote.deadline: the deposit address goes inactive
  inactive_unix      INTEGER,                        -- quote.timeWhenInactive
  correlation_id     TEXT NOT NULL,
  signature_valid    INTEGER NOT NULL,
  quote_json         TEXT NOT NULL,                  -- the whole signed response, for disputes
  status             TEXT NOT NULL CHECK (status IN ('awaiting_deposit', 'deposit_detected', 'incomplete_deposit', 'processing',
                                                     'delivered', 'confirmed', 'refunded', 'failed', 'expired')),
  provider_status    TEXT,                           -- last raw 1Click status
  deposited_amount   TEXT,
  delivered_amount   TEXT,
  refunded_amount    TEXT,
  refund_reason      TEXT,
  origin_txs         TEXT NOT NULL DEFAULT '[]',     -- JSON [{hash, explorerUrl}]
  destination_txs    TEXT NOT NULL DEFAULT '[]',
  near_txs           TEXT NOT NULL DEFAULT '[]',
  delivery_tx        TEXT,                           -- the NEAR transaction the node read the delivery from
  verification       TEXT CHECK (verification IN ('rpc_checked', 'provider_only')),
  delivered_unix     INTEGER,                        -- when 1Click first reported SUCCESS
  last_status_json   TEXT,
  next_poll_unix     INTEGER NOT NULL,
  poll_errors        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX intents_quotes_payment ON intents_quotes (payment_id);
CREATE INDEX intents_quotes_due ON intents_quotes (status, next_poll_unix);

-- A credit of an any-chain payment names its quote; one credit per quote.
ALTER TABLE payment_credits ADD COLUMN intents_quote_id TEXT;
CREATE UNIQUE INDEX payment_credits_intents_quote ON payment_credits (intents_quote_id) WHERE intents_quote_id IS NOT NULL;

-- The method row 001 already allows: off for every existing business until it proves an account and turns it on.
INSERT INTO merchant_methods (merchant_id, method, enabled, updated_at)
  SELECT id, 'oneclick', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM merchants
  WHERE NOT EXISTS (SELECT 1 FROM merchant_methods m WHERE m.merchant_id = merchants.id AND m.method = 'oneclick');
