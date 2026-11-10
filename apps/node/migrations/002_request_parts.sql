-- A request paid with several vouchers (a gateway payment split between the merchant and the platform fee) is one call
-- for the Budget's limits. request_part is 0 for the first or only voucher of a request and counts up for the others,
-- so the per-minute and same-request windows count requests, not vouchers.
ALTER TABLE calls ADD COLUMN request_part INTEGER NOT NULL DEFAULT 0;
