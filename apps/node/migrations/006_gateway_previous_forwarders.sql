-- Forwarders a payment was quoted with before a re-quote moved it (docs/GATEWAY.md section 15).
-- The checkout may have shown one to a payer who already sent money to it, so each stays watched with its own terms:
-- a deposit to it restores that quote on an untouched payment, is credited either way, and is flushed with its terms.
CREATE TABLE payment_forwarders (
  address       TEXT PRIMARY KEY,
  payment_id    TEXT NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  quote_method  TEXT,
  surcharge     TEXT NOT NULL,
  amount_due    TEXT NOT NULL,
  platform_fee  TEXT NOT NULL,
  method_fee    TEXT NOT NULL,
  fee_total     TEXT NOT NULL,
  net_amount    TEXT NOT NULL,
  fee_recipient TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX payment_forwarders_payment ON payment_forwarders (payment_id);
