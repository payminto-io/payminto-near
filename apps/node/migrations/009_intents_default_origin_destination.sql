-- Any-chain checkout: the token the hosted checkout pre-selects, and where a business's USDC lands ("receive as").
-- Additive only. Every existing business keeps NEAR as its destination (its `intents_payout` account), and every
-- existing quote keeps NEAR as where it delivered.

-- A 1Click origin asset id the checkout pre-selects; null: none. The node checks it is offered when it is set.
ALTER TABLE merchants ADD COLUMN intents_default_origin TEXT;

-- The chain the business receives USDC on: `near` (the default: `intents_payout` is the account) or an EVM chain
-- (`base`, `arb`, `eth`, `pol`, `op`). No CHECK on the chain list, so offering another chain needs no table rebuild; the
-- node validates it.
ALTER TABLE merchants ADD COLUMN intents_destination_chain TEXT NOT NULL DEFAULT 'near';
-- The 1Click asset id of the destination USDC; null on NEAR (the node's USDC).
ALTER TABLE merchants ADD COLUMN intents_destination_asset TEXT;
-- EVM only: the business's address, lowercased, and its EIP-191 proof as JSON {type, timestamp, signature, chain_id, hub}.
ALTER TABLE merchants ADD COLUMN intents_destination_address TEXT;
ALTER TABLE merchants ADD COLUMN intents_destination_proof TEXT;
ALTER TABLE merchants ADD COLUMN intents_destination_proven_at TEXT;

-- Where each quote delivers: `near` for every quote made before this migration.
ALTER TABLE intents_quotes ADD COLUMN destination_chain TEXT NOT NULL DEFAULT 'near';
-- The quote's 1Click destination asset id; null on rows made before this migration (NEAR USDC).
ALTER TABLE intents_quotes ADD COLUMN destination_asset TEXT;
