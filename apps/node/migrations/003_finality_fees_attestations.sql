-- migrate: foreign-keys-off
-- Finality, L1 data fee, transaction replacement and EAS attestation per batch.
-- SQLite cannot change a CHECK constraint in place, so batches is rebuilt (the documented 12-step procedure);
-- the migration runner turns foreign keys off around it and runs PRAGMA foreign_key_check before committing.
-- Status 'included' means the settlement transaction has one confirmation; 'confirmed' means its block is at or below
-- the configured finality head (CONFIRM_TAG), and only then are the ledger and HSP updated.
CREATE TABLE batches_new (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       TEXT UNIQUE,
  status         TEXT NOT NULL CHECK (status IN ('building', 'cosigning', 'submitted', 'included', 'confirmed', 'failed')),
  token          TEXT NOT NULL,
  receipts_root  TEXT,
  claims         INTEGER NOT NULL DEFAULT 0,
  calls          INTEGER NOT NULL DEFAULT 0,
  gross          TEXT NOT NULL DEFAULT '0',
  net            TEXT NOT NULL DEFAULT '0',
  transfers      INTEGER NOT NULL DEFAULT 0,
  projected_gross TEXT NOT NULL DEFAULT '0',
  projected_net   TEXT NOT NULL DEFAULT '0',
  reconciled     INTEGER,
  tx_hash        TEXT,
  block_number   INTEGER,
  gas_used       TEXT,
  gas_price      TEXT,
  error          TEXT,
  trigger        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  submitted_at   TEXT,
  confirmed_at   TEXT,
  l1_fee         TEXT,                         -- OP Stack L1 data fee in wei from the receipt; NULL off OP Stack chains
  included_at    TEXT,
  block_hash     TEXT,
  tx_nonce       INTEGER,
  raw_tx         TEXT,                         -- latest signed transaction, rebroadcast after a reorg
  replacements   INTEGER NOT NULL DEFAULT 0,   -- same-nonce fee bumps sent
  attestation_uid TEXT,                        -- EAS attestation of the confirmed batch (EAS_ATTEST=true)
  attestation_tx  TEXT
);
INSERT INTO batches_new (seq, batch_id, status, token, receipts_root, claims, calls, gross, net, transfers, projected_gross,
                         projected_net, reconciled, tx_hash, block_number, gas_used, gas_price, error, trigger, created_at,
                         submitted_at, confirmed_at, included_at)
SELECT seq, batch_id, status, token, receipts_root, claims, calls, gross, net, transfers, projected_gross, projected_net,
       reconciled, tx_hash, block_number, gas_used, gas_price, error, trigger, created_at, submitted_at, confirmed_at,
       CASE WHEN status = 'confirmed' THEN confirmed_at END
FROM batches;
DROP TABLE batches;
ALTER TABLE batches_new RENAME TO batches;
CREATE INDEX batches_status ON batches (status);
