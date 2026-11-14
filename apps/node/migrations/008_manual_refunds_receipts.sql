-- migrate: foreign-keys-off
-- Manual refunds of any-chain payments, and the receipt email's sent mark.
--
-- A payment that came from another chain through NEAR Intents is refunded by the business from its own wallet on that
-- chain; the node records it (method and verification `manual`, the chain, the transaction and who recorded it) and
-- never moves money. SQLite cannot widen a CHECK constraint in place, so `refunds` is rebuilt with SQLite's 12-step
-- procedure: every row is copied as it is, and the indexes are created again. Nothing references refunds (id).

CREATE TABLE refunds_new (
  id             TEXT PRIMARY KEY,              -- re_...
  merchant_id    TEXT NOT NULL REFERENCES merchants (id),
  payment_id     TEXT NOT NULL REFERENCES payments (id),
  amount         TEXT NOT NULL,
  reason         TEXT,
  to_addr        TEXT NOT NULL,                 -- NEAR account the merchant refunds, or `<chain>:<address>` for a manual refund
  status         TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  method         TEXT CHECK (method IN ('transfer', 'manual')),
  tx_hash        TEXT UNIQUE,                   -- the merchant's own ft_transfer, sent from its payout account
  verification   TEXT CHECK (verification IN ('transfer_checked', 'finality_only', 'manual')),
  submitted_unix INTEGER,
  failure_reason TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  note           TEXT,
  approval       TEXT NOT NULL DEFAULT 'not_required' CHECK (approval IN ('not_required', 'requested', 'approved')),
  requested_by   TEXT,
  approved_by    TEXT,
  approved_at    TEXT,
  -- Manual refunds only: the origin chain (`base`, `sol`, ...), the business's transaction on it, and who recorded it.
  manual_chain   TEXT,
  manual_tx_hash TEXT,
  recorded_by    TEXT,
  CHECK ((method = 'manual') = (manual_chain IS NOT NULL AND manual_tx_hash IS NOT NULL))
);

INSERT INTO refunds_new (id, merchant_id, payment_id, amount, reason, to_addr, status, method, tx_hash, verification, submitted_unix, failure_reason,
                         created_at, updated_at, note, approval, requested_by, approved_by, approved_at)
  SELECT id, merchant_id, payment_id, amount, reason, to_addr, status, method, tx_hash, verification, submitted_unix, failure_reason,
         created_at, updated_at, note, approval, requested_by, approved_by, approved_at
  FROM refunds;

DROP TABLE refunds;
ALTER TABLE refunds_new RENAME TO refunds;

CREATE INDEX refunds_payment ON refunds (payment_id);
CREATE INDEX refunds_status ON refunds (status);
CREATE INDEX refunds_tx_lc ON refunds (lower(tx_hash));
CREATE INDEX refunds_to_lc ON refunds (lower(to_addr));
CREATE INDEX refunds_merchant ON refunds (merchant_id);
-- One transaction on the origin chain records one refund, like a NEAR refund transaction.
CREATE UNIQUE INDEX refunds_manual_tx ON refunds (manual_chain, lower(manual_tx_hash)) WHERE manual_tx_hash IS NOT NULL;

-- When the receipt email of a paid payment was queued: set once, in the transaction that queues it, so a restart or a
-- second save never sends it twice. Payments paid before this migration were never promised one by the node.
ALTER TABLE payments ADD COLUMN receipt_sent_at TEXT;
