-- A refusal is recorded only for a voucher the Budget's agent key signed, and the voucher's signature is kept with it.
-- Rows written before this column existed have none: they were recorded before the signature was checked, so the node
-- shows them to its operator as before but never signs them or returns them to an agent as its own record.
ALTER TABLE denials ADD COLUMN agent_signature TEXT;

-- The agent's lookup of the node's record of a refusal: by Budget and request hash.
CREATE INDEX denials_budget_request ON denials (budget_id, request_hash);
