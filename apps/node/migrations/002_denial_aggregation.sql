-- Identical denials (same mandate, payee, provider, rule, request hash and cumulative) within DENIAL_DEDUP_SEC
-- are folded into one row: repeats counts them and last_seen is the newest. A replay flood then costs one row.
ALTER TABLE denials ADD COLUMN repeats INTEGER NOT NULL DEFAULT 1;
ALTER TABLE denials ADD COLUMN last_seen INTEGER;
CREATE INDEX denials_dedup ON denials (mandate_id, request_hash, cumulative);
