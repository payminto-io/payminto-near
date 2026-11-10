/** A NEAR account id, for example `hub.payminto.testnet`. Validate untrusted input with isAccountId. */
export type AccountId = string;
/** A NEAR transaction hash, base58 text. */
export type TxHash = string;
/** An ed25519 public key in NEAR text form: `ed25519:<base58 of 32 bytes>`. */
export type PublicKey = `ed25519:${string}`;
/** 32 bytes as 64 lowercase hex characters, with no 0x prefix. */
export type Id32 = string;
/** A 64-byte ed25519 signature as 128 lowercase hex characters, with no 0x prefix. */
export type Sig64 = string;
/** CAIP-style network names, used verbatim as the `network` string in every digest. */
export type Network = "near:testnet" | "near:sandbox" | "near:mainnet";

/** What a Budget owner commits to. `budgetIdOf` hashes these terms. `cap` is authority; escrow is funding and is not part of the terms. */
export type BudgetTerms = {
  owner: AccountId;
  agentPk: PublicKey;
  /** The only account allowed to include this Budget in `settle_batch`. */
  settler: AccountId;
  /** Gross spending limit in atomic token units. Deposits never raise it. */
  cap: bigint;
  /** Unix milliseconds. */
  validUntil: bigint;
  /** Allowed payees, at most 16. Empty means any payee. Canonicalized (sorted, unique) before hashing. */
  payees: AccountId[];
  policyHash: Id32;
  /** Lets one owner open several Budgets with otherwise equal terms. */
  salt: Id32;
};

/** On-chain Budget state. */
export type Budget = {
  id: Id32;
  owner: AccountId;
  agentPk: PublicKey;
  settler: AccountId;
  cap: bigint;
  /** Gross total ever settled against this Budget. */
  spent: bigint;
  /** Tokens currently held for this Budget. */
  escrow: bigint;
  validUntil: bigint;
  /** Unix milliseconds of the revoke, or null. */
  revokedAt: bigint | null;
  payees: AccountId[];
  policyHash: Id32;
};

/** The fields an agent signs for one call. `amount` and `requestHash` bind the signature to that specific call. */
export type Voucher = {
  budgetId: Id32;
  payee: AccountId;
  /** Price of this call in atomic units. */
  amount: bigint;
  /** Running total to this payee under this Budget, including this call. */
  cumulative: bigint;
  requestHash: Id32;
};

/** The latest voucher of a (Budget, payee) pair, submitted for settlement. */
export type Claim = Voucher & { signature: Sig64 };

/**
 * The node's signed acceptance of one call. `settle_own` requires it next to the claim: it shows that the Budget's
 * settler accepted exactly that call, and when. The node returns it in the receipt of every call it accepts.
 */
export type Acceptance = {
  /** The receipt key that signed. It must be registered on the hub by the Budget's settler (`receiptKeys`). */
  nodeKey: PublicKey;
  /** Unix seconds at which the node accepted the call, as signed. The hub compares it in milliseconds. */
  timestampS: bigint;
  signature: Sig64;
};

/** One party's result in a batch. Exactly one of debit and credit is positive. */
export type NetEntry = { account: AccountId; debit: bigint; credit: bigint };

export type SettleArgs = {
  batchId: Id32;
  root: Id32;
  claims: Claim[];
  /** Canonical netting result: sorted by account, zero entries omitted. The hub recomputes it and asserts equality. */
  expectedNet: NetEntry[];
};

export type Batch = {
  root: Id32;
  settler: AccountId;
  gross: bigint;
  net: bigint;
  /** Block time in Unix milliseconds. */
  at: bigint;
};

export type Payment = {
  id: Id32;
  merchant: AccountId;
  amount: bigint;
  payer: AccountId;
  at: bigint;
};

/** Terms the node signs with its checkout key for one hosted-checkout payment. */
export type CheckoutTerms = {
  paymentId: Id32;
  merchant: AccountId;
  amount: bigint;
  expiryMs: bigint;
};

/** Everything committed for one call in a batch's Merkle tree, except the batch context (domain, hub, network, batch id). */
export type ReceiptFields = {
  callId: Id32;
  budgetId: Id32;
  payee: AccountId;
  amount: bigint;
  cumulative: bigint;
  requestHash: Id32;
  /** Node-attested acceptance time. The chain does not prove it. */
  timestampMs: bigint;
  voucherSig: Sig64;
};

export type TxState = { status: "unknown" | "pending" | "final" } | { status: "failed"; error: string };
