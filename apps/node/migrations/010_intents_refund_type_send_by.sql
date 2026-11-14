-- One-screen checkout: a deposit address without a buyer refund address, and the time a buyer must send by.
-- Additive only. Every existing quote refunded to the buyer's address on the origin chain.

-- `ORIGIN_CHAIN`: `refund_to` is the buyer's address on the origin chain. `INTENTS`: `refund_to` is the business's NEAR
-- account, whose NEAR Intents balance takes a failed or short deposit back; the business returns it to the buyer.
ALTER TABLE intents_quotes ADD COLUMN refund_type TEXT NOT NULL DEFAULT 'ORIGIN_CHAIN';

-- The deadline this node asked 1Click for (the earlier of the payment's expiry and the quote's lifetime). 1Click may
-- answer a later `deadline` (when its refunds begin); a buyer is told to send by this one. Null for older quotes.
ALTER TABLE intents_quotes ADD COLUMN send_by_unix INTEGER;
