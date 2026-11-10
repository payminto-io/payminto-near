-- migrate: foreign-keys-off
-- A payee can settle its own latest voucher on the hub (`settle_own`), outside any batch of this node. The node books
-- what it finds settled that way: one row per movement of the hub's settled position of a (Budget, payee) pair that no
-- batch of this node made. The calls it covers are settled with seller_settlement_seq set, and have no batch and no
-- Merkle proof.
CREATE TABLE seller_settlements (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,             -- sst_...
  budget_id   TEXT NOT NULL REFERENCES budgets (id),
  payee       TEXT NOT NULL,
  previous    TEXT NOT NULL,                    -- settled position before, as this node had it
  cumulative  TEXT NOT NULL,                    -- settled position the hub reported
  delta       TEXT NOT NULL,                    -- cumulative - previous: what the hub moved from escrow to the payee's credit
  uncleared   TEXT NOT NULL DEFAULT '0',        -- part of delta above this node's accepted position: a voucher it never accepted
  calls       INTEGER NOT NULL,                 -- accepted calls this settled
  detected_at TEXT NOT NULL
);

CREATE INDEX seller_settlements_pair ON seller_settlements (budget_id, payee);

CREATE INDEX seller_settlements_time ON seller_settlements (detected_at);

ALTER TABLE calls ADD COLUMN seller_settlement_seq INTEGER REFERENCES seller_settlements (seq);

CREATE INDEX calls_seller_settlement ON calls (seller_settlement_seq);

-- The journal of such a settlement is its own kind. SQLite cannot change a CHECK in place, so the table is rebuilt
-- with every row copied (the documented procedure: foreign keys off for this file, checked again before it commits).
-- ledger_entries keeps referring to the table by its name.
CREATE TABLE journals_rebuilt (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('call.accepted', 'batch.settled', 'seller.settled')),
  ref        TEXT NOT NULL,
  memo       TEXT NOT NULL,
  at         TEXT NOT NULL
);

INSERT INTO journals_rebuilt (id, kind, ref, memo, at) SELECT id, kind, ref, memo, at FROM journals;

DROP TABLE journals;

ALTER TABLE journals_rebuilt RENAME TO journals;
