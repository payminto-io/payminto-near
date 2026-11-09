-- Draft payments and webhook endpoint health (docs/GATEWAY.md section 15).
-- A draft is a payment an unpaid x402 request created so its forwarder can be payTo: not listed, no webhooks, not in
-- stats, reused for the same link and requester while it lives, promoted on its first credit or valid signature, and
-- deleted after expiry.
ALTER TABLE payments ADD COLUMN draft INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN draft_key TEXT;                -- sha256(link id, client IP, User-Agent)
CREATE INDEX payments_draft ON payments (draft, draft_key);

-- An endpoint that only failed for 3 days is disabled; PATCH {active: true} re-enables it.
ALTER TABLE webhook_endpoints ADD COLUMN failing_since INTEGER;  -- unix seconds of the first failure since the last success
ALTER TABLE webhook_endpoints ADD COLUMN disabled_reason TEXT;
