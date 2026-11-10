import { compareAscii } from "./bytes.ts";
import type { Chain } from "./chain.ts";
import { ChainError, DEFAULT_MAX_PAYEES, EXPIRY_GRACE_MS, MAX_ANY_PAYEES, MAX_CLAIMS, MAX_PAYEES, MAX_PAYOUT_ACCOUNTS, MAX_PRUNE_PAYEES, MAX_RECEIPT_KEYS } from "./constants.ts";
import { publicKeyProblem, verifyDigest } from "./crypto.ts";
import { acceptanceInTime, acceptanceSignedFor, budgetIdOf, canonicalPayees, checkoutDigest, voucherDigest } from "./digest.ts";
import { receiptLeaf, verifyMerkleProof } from "./merkle.ts";
import { computeNetting, sameNet, settleDeadline, type NettingLine } from "./netting.ts";
import { PAIR_BYTES, storageBytes, storageCost, type CreditFunder } from "./storage.ts";
import type { Acceptance, AccountId, Batch, Budget, BudgetTerms, Claim, Id32, Network, Payment, PublicKey, ReceiptFields, SettleArgs, TxHash, TxState } from "./types.ts";

export type FakeChainOptions = {
  hub?: AccountId;
  network?: Network;
  token?: AccountId;
  /** The account `settle` and `payout` act as. */
  operator?: AccountId;
  /** Starting block time in Unix milliseconds. Defaults to the wall clock and then only moves through `advance`. */
  nowMs?: bigint;
};

export type FakeTotals = { tokenBalance: bigint; escrow: bigint; credits: bigint; inFlight: bigint };

/** What `addSettler` prepays for a settler's storage unless told otherwise: 10 NEAR, far more than any test writes. */
export const FAKE_SETTLER_STORAGE = 10n ** 25n;

const settledKey = (id: Id32, payee: AccountId) => `${id}:${payee}`;
const batchKey = (settler: AccountId, id: Id32) => `${settler}:${id}`;

/**
 * The hub's key rule: it refuses a key that is not the canonical encoding of its point, or that is of small order.
 * It cannot tell a non-point from a point, so this does not refuse one; no signature ever verifies under it anyway.
 */
function hubRefusesKey(key: PublicKey | Uint8Array): boolean {
  const problem = publicKeyProblem(key);
  return problem === "small_order" || problem === "non_canonical";
}

/** Per-batch working state, committed only when every check has passed. */
type Workspace = { settled: Map<string, bigint>; spent: Map<Id32, bigint> };

/** Withdrawable credit, and who paid for the entry's storage and gets it back when the entry is removed. */
type Credit = { amount: bigint; funder: CreditFunder };

/**
 * An honest in-memory model of the clearing hub and its NEP-141 token. Same rules and refusal codes as the Rust contract,
 * in the same check order, so tests through this class exercise what the chain will really do. Storage is modelled byte
 * for byte with `storageBytes`, so the hub's rule that it never pays for storage holds here too. Time is explicit and
 * never reads the wall clock after construction. Owner and wallet actions exist here only for tests; the `Chain`
 * interface has none of them.
 */
export class FakeChain implements Chain {
  readonly hub: AccountId;
  readonly token: AccountId;
  readonly network: Network;
  readonly operator: AccountId;

  #now: bigint;
  #txSeq = 0;
  readonly #budgets = new Map<Id32, Budget>();
  /** Each Budget's storage reserve: bytes its owner prepaid for settlement storage and nobody has used yet. */
  readonly #reserved = new Map<Id32, number>();
  readonly #settled = new Map<string, bigint>();
  readonly #credits = new Map<AccountId, Credit>();
  /** Keyed by settler and batch id: batch ids belong to their settler. */
  readonly #batches = new Map<string, Batch>();
  readonly #payments = new Map<Id32, Payment>();
  readonly #settlers = new Set<AccountId>();
  /** Receipt keys per settler, append-only. */
  readonly #receiptKeys = new Map<AccountId, PublicKey[]>();
  /** Prepaid storage balances in yoctoNEAR. An entry is never removed, as on the hub. */
  readonly #storage = new Map<AccountId, bigint>();
  readonly #balances = new Map<AccountId, bigint>();
  readonly #registered = new Set<AccountId>();
  readonly #txs = new Map<TxHash, TxState>();
  readonly #failTransferTo = new Set<AccountId>();
  #checkout: { key: PublicKey; settler: AccountId } | null = null;
  #inFlight = 0n;

  constructor(o: FakeChainOptions = {}) {
    this.hub = o.hub ?? "hub.payminto.testnet";
    this.token = o.token ?? "usdc.fake.testnet";
    this.network = o.network ?? "near:testnet";
    this.operator = o.operator ?? "node.payminto.testnet";
    this.#now = o.nowMs ?? BigInt(Date.now());
    this.#registered.add(this.hub);
  }

  // ---- test control ----

  get nowMs(): bigint {
    return this.#now;
  }

  advance(ms: bigint): void {
    this.#now += ms;
  }

  /** Sets the block time, never backwards. */
  setNow(ms: bigint): void {
    if (ms > this.#now) this.#now = ms;
  }

  register(account: AccountId): void {
    this.#registered.add(account);
  }

  unregister(account: AccountId): void {
    this.#registered.delete(account);
  }

  mint(account: AccountId, amount: bigint): void {
    this.#registered.add(account);
    this.#balances.set(account, this.#bal(account) + amount);
  }

  /**
   * The admin's `set_settler`, plus a prepaid storage balance so the settler can settle straight away. On the hub
   * these are two steps by two accounts: pass `storageYocto` 0 to model a settler that has not prepaid yet.
   */
  addSettler(account: AccountId, storageYocto: bigint = FAKE_SETTLER_STORAGE): void {
    this.#settlers.add(account);
    if (storageYocto > 0n) this.#storage.set(account, (this.#storage.get(account) ?? 0n) + storageYocto);
  }

  /** The admin's `set_settler(account, false)`. The settler's receipt keys and storage balance stay. */
  removeSettler(account: AccountId): void {
    this.#settlers.delete(account);
  }

  /** The admin's `set_checkout_key`: the key that signs checkout terms, and the settler whose storage balance pays for payments. */
  setCheckoutKey(key: PublicKey, settler: AccountId = this.operator): void {
    if (!this.#settlers.has(settler)) throw new ChainError("NOT_SETTLER", settler);
    if (hubRefusesKey(key)) throw new ChainError("INVALID_KEY", key);
    this.#checkout = { key, settler };
  }

  /** The next token transfer to `account` fails, so the callback path runs. */
  failNextTransferTo(account: AccountId): void {
    this.#failTransferTo.add(account);
  }

  /** The Budget's storage reserve: bytes its owner prepaid for settlement storage and nobody has used yet. */
  storageReserve(budgetId: Id32): number {
    return this.#reserved.get(budgetId) ?? 0;
  }

  /** True while the hub stores a credit entry for the account. A paid-out entry is removed. */
  hasCreditEntry(account: AccountId): boolean {
    return this.#credits.has(account);
  }

  totals(): FakeTotals {
    const sum = (xs: Iterable<bigint>) => [...xs].reduce((a, b) => a + b, 0n);
    return {
      tokenBalance: this.#bal(this.hub),
      escrow: sum([...this.#budgets.values()].map((b) => b.escrow)),
      credits: sum([...this.#credits.values()].map((c) => c.amount)),
      inFlight: this.#inFlight,
    };
  }

  /** The hub's core invariant: token balance equals the sum of escrow, credits and in-flight payouts. */
  solvency(): void {
    const t = this.totals();
    if (t.tokenBalance !== t.escrow + t.credits + t.inFlight) {
      throw new Error(`solvency broken: balance ${t.tokenBalance} != escrow ${t.escrow} + credits ${t.credits} + in flight ${t.inFlight}`);
    }
  }

  // ---- wallet actions (the owner, payer, payee or settler signs these on the real chain) ----

  /** `open_budget`, with `owner` as the predecessor. The id binds the caller, so a caller cannot open someone else's terms. */
  /**
   * `open_budget`, with `owner` as the predecessor. The id binds the caller, so a caller cannot open someone else's terms.
   * As `budgetTermsArgs` sends them: an empty list is `allow_any_payee` with `maxPayees` (default 16) slots, and a list
   * gets one slot per payee. The owner's storage reserve is `PAIR_BYTES` per slot.
   */
  openBudget(owner: AccountId, t: BudgetTerms): Id32 {
    if (t.owner !== owner) throw new ChainError("NOT_OWNER", "terms.owner must be the caller");
    if (t.cap <= 0n || t.validUntil <= this.#now) throw new ChainError("INVALID_BUDGET", "cap must be positive and validUntil in the future");
    if (t.validUntil > 2n ** 64n - 1n - EXPIRY_GRACE_MS) throw new ChainError("INVALID_BUDGET", "validUntil is too far in the future");
    if (new Set(t.payees).size > MAX_PAYEES) throw new ChainError("INVALID_BUDGET", `at most ${MAX_PAYEES} payees`);
    const payees = canonicalPayees(t.payees);
    let slots: number;
    if (payees.length === 0) {
      slots = t.maxPayees ?? DEFAULT_MAX_PAYEES;
      if (!Number.isInteger(slots) || slots < 1 || slots > MAX_ANY_PAYEES) throw new ChainError("INVALID_BUDGET", `maxPayees must be 1 to ${MAX_ANY_PAYEES}`);
    } else {
      slots = payees.length;
    }
    if (payees.some((p) => this.#isReserved(p))) throw new ChainError("INVALID_BUDGET", "the hub and the token cannot be payees");
    if (hubRefusesKey(t.agentPk)) throw new ChainError("INVALID_BUDGET", "the agent key is of small order or not canonical");
    const id = budgetIdOf(this.hub, this.network, t);
    if (this.#budgets.has(id)) throw new ChainError("BUDGET_EXISTS");
    this.#budgets.set(id, { id, owner, agentPk: t.agentPk, settler: t.settler, cap: t.cap, spent: 0n, escrow: 0n, validUntil: t.validUntil, revokedAt: null, payees, policyHash: t.policyHash });
    this.#reserved.set(id, slots * PAIR_BYTES);
    return id;
  }

  /** Convenience for tests: `ft_transfer_call` with a `budget` message, throwing if the hub refunds it. */
  depositBudget(owner: AccountId, budgetId: Id32, amount: bigint): void {
    const { refunded } = this.ftTransferCall(owner, amount, JSON.stringify({ budget: { budget_id: budgetId } }));
    if (refunded !== 0n) throw new Error(`deposit refunded: ${refunded}`);
  }

  /** NEP-141 `ft_transfer_call` into the hub. The hub returns unused tokens rather than panicking, like `ft_on_transfer`. */
  ftTransferCall(sender: AccountId, amount: bigint, msg: string): { refunded: bigint } {
    if (amount <= 0n) throw new Error("amount must be positive");
    if (this.#bal(sender) < amount) throw new Error("insufficient token balance");
    this.#balances.set(sender, this.#bal(sender) - amount);
    this.#balances.set(this.hub, this.#bal(this.hub) + amount);
    const kept = this.#onTransfer(sender, amount, msg);
    const refunded = kept ? 0n : amount;
    if (refunded > 0n) {
      this.#balances.set(this.hub, this.#bal(this.hub) - refunded);
      this.#balances.set(sender, this.#bal(sender) + refunded);
    }
    return { refunded };
  }

  async revokeBudget(owner: AccountId, id: Id32): Promise<TxHash> {
    const b = this.#mustBudget(id);
    if (b.owner !== owner) throw new ChainError("NOT_OWNER");
    if (b.revokedAt !== null) throw new ChainError("ALREADY_REVOKED");
    // After expiry the 3-day expiry grace is running, and a revoke could only shorten it.
    if (this.#now > b.validUntil) throw new ChainError("BUDGET_NOT_OPEN", "the Budget has expired");
    b.revokedAt = this.#now;
    return this.#tx();
  }

  /**
   * `prune`: after the settlement deadline, the owner removes the Budget's `settled` entries for `payees` and gets back
   * the storage they freed plus the unused reserve. Returns that refund in yoctoNEAR. The Budget record stays.
   */
  async prune(owner: AccountId, id: Id32, payees: readonly AccountId[]): Promise<{ txHash: TxHash; refundedYocto: bigint }> {
    const b = this.#mustBudget(id);
    if (b.owner !== owner) throw new ChainError("NOT_OWNER");
    if (payees.length > MAX_PRUNE_PAYEES) throw new ChainError("TOO_MANY_ACCOUNTS", `${payees.length} > ${MAX_PRUNE_PAYEES}`);
    if (this.#now <= settleDeadline(b)) throw new ChainError("TOO_EARLY", "the settlement deadline has not passed");
    let freed = 0;
    for (const p of payees) if (this.#settled.delete(settledKey(id, p))) freed += storageBytes.settled(p);
    const refundedYocto = storageCost(freed + (this.#reserved.get(id) ?? 0));
    this.#reserved.set(id, 0);
    return { txHash: this.#tx(), refundedYocto };
  }

  /** After the settlement deadline. Escrow is zeroed before the transfer, and restored by the callback if it fails. */
  async reclaim(owner: AccountId, id: Id32): Promise<TxHash> {
    const b = this.#mustBudget(id);
    if (b.owner !== owner) throw new ChainError("NOT_OWNER");
    if (this.#now <= settleDeadline(b)) throw new ChainError("TOO_EARLY", "the settlement deadline has not passed");
    const amount = b.escrow;
    b.escrow = 0n;
    if (amount > 0n && !this.#transfer(owner, amount)) b.escrow = amount;
    return this.#tx();
  }

  /**
   * `fund_from_credit`: moves the caller's own credit into the escrow of one of the caller's open Budgets.
   * Raises escrow only, never cap, and moves no tokens. `attachedYocto` models the exact one yoctoNEAR the hub requires.
   */
  async fundFromCredit(owner: AccountId, id: Id32, amount: bigint, attachedYocto = 1n): Promise<TxHash> {
    const b = this.#mustBudget(id);
    if (b.owner !== owner) throw new ChainError("NOT_OWNER");
    oneYocto(attachedYocto);
    if (amount <= 0n) throw new ChainError("ZERO_AMOUNT");
    if (b.revokedAt !== null || this.#now > b.validUntil) throw new ChainError("BUDGET_NOT_OPEN", id);
    const credit = this.#credits.get(owner);
    if (!credit || credit.amount < amount) throw new ChainError("INSUFFICIENT_CREDIT", `${credit?.amount ?? 0n} < ${amount}`);
    credit.amount -= amount;
    this.#releaseCreditIfEmpty(owner);
    b.escrow += amount;
    return this.#tx();
  }

  /**
   * `fund_storage`: adds yoctoNEAR to an account's storage balance. Anyone may fund any account. The first deposit pays
   * for the balance entry itself.
   */
  async fundStorage(account: AccountId, yocto: bigint): Promise<TxHash> {
    if (yocto <= 0n) throw new ChainError("ZERO_AMOUNT");
    if (this.#isReserved(account)) throw new ChainError("RESERVED_ACCOUNT", `${account} could never withdraw a storage balance`);
    const existing = this.#storage.get(account);
    const cost = existing === undefined ? storageCost(storageBytes.storageBalance(account)) : 0n;
    if (yocto < cost) throw new ChainError("INSUFFICIENT_DEPOSIT", `${yocto} < ${cost}`);
    this.#storage.set(account, (existing ?? 0n) + yocto - cost);
    return this.#tx();
  }

  /** `withdraw_storage`: the account takes back unused storage balance. Exactly one yoctoNEAR, as on the hub. */
  async withdrawStorage(account: AccountId, amount: bigint, attachedYocto = 1n): Promise<TxHash> {
    oneYocto(attachedYocto);
    if (amount <= 0n) throw new ChainError("ZERO_AMOUNT");
    const balance = this.#storage.get(account) ?? 0n;
    if (balance < amount) throw new ChainError("INSUFFICIENT_STORAGE", `${balance} < ${amount}`);
    this.#storage.set(account, balance - amount);
    return this.#tx();
  }

  /**
   * `register_receipt_key`: an allowlisted settler adds a key it signs acceptances with. Exactly one yoctoNEAR, so a
   * function-call key cannot do it. Keys are only ever added, at most `MAX_RECEIPT_KEYS`.
   */
  async registerReceiptKey(settler: AccountId, key: PublicKey, attachedYocto = 1n): Promise<TxHash> {
    if (!this.#settlers.has(settler)) throw new ChainError("NOT_SETTLER", settler);
    oneYocto(attachedYocto);
    if (hubRefusesKey(key)) throw new ChainError("INVALID_KEY", key);
    const keys = this.#receiptKeys.get(settler) ?? [];
    if (keys.includes(key)) throw new ChainError("RECEIPT_KEY_EXISTS", key);
    if (keys.length >= MAX_RECEIPT_KEYS) throw new ChainError("TOO_MANY_RECEIPT_KEYS", `${keys.length} >= ${MAX_RECEIPT_KEYS}`);
    this.#chargeStorage(settler, storageBytes.receiptKeys(settler, keys.length + 1) - storageBytes.receiptKeys(settler, keys.length));
    this.#receiptKeys.set(settler, [...keys, key]);
    return this.#tx();
  }

  /**
   * `settle_batch` as an arbitrary caller. Atomic: nothing changes unless every check passes. Each Budget pays for its
   * own new `settled` entries, and for the credit entries of payees its claim reached first, from its storage reserve;
   * the settler pays for its batch record only.
   */
  async settleAs(caller: AccountId, a: SettleArgs): Promise<TxHash> {
    if (!this.#settlers.has(caller)) throw new ChainError("NOT_SETTLER", caller);
    if (this.#batches.has(batchKey(caller, a.batchId))) throw new ChainError("BATCH_EXISTS", a.batchId);
    if (a.claims.length > MAX_CLAIMS) throw new ChainError("TOO_MANY_CLAIMS", `${a.claims.length} > ${MAX_CLAIMS}`);

    const work = this.#workspace();
    const lines: NettingLine[] = [];
    const ownerBudget = new Map<AccountId, Id32>();
    const firstPayer = new Map<AccountId, Id32>();
    for (const c of a.claims) {
      const b = this.#budgets.get(c.budgetId);
      if (!b) throw new ChainError("UNKNOWN_BUDGET", c.budgetId);
      if (b.settler !== caller) throw new ChainError("NOT_BUDGET_SETTLER", c.budgetId);
      const prior = ownerBudget.get(b.owner);
      if (prior !== undefined && prior !== c.budgetId) throw new ChainError("ONE_BUDGET_PER_OWNER", b.owner);
      ownerBudget.set(b.owner, c.budgetId);
      if (this.#now > settleDeadline(b)) throw new ChainError("BUDGET_CLOSED", b.id);
      lines.push({ owner: b.owner, payee: c.payee, delta: this.#applyDelta(work, b, c, this.#claimDelta(work, b, c)) });
      if (!firstPayer.has(c.payee)) firstPayer.set(c.payee, c.budgetId);
    }

    const { gross, net, entries } = computeNetting(lines);
    if (gross === 0n) throw new ChainError("ZERO_GROSS");
    if (!sameNet(a.expectedNet, entries)) throw new ChainError("NET_MISMATCH");

    const debited = new Map<Id32, bigint>();
    const credited = new Map<AccountId, bigint>();
    for (const e of entries) {
      if (e.debit > 0n) {
        const id = ownerBudget.get(e.account)!;
        if (this.#budgets.get(id)!.escrow < e.debit) throw new ChainError("INSUFFICIENT_ESCROW", e.account);
        debited.set(id, e.debit);
      } else {
        credited.set(e.account, e.credit);
      }
    }

    // Each Budget pays from its reserve for its new settled entries and the new credit entries it is first payer for.
    const charged = new Map<Id32, number>();
    const charge = (id: Id32, bytes: number) => charged.set(id, (charged.get(id) ?? 0) + bytes);
    for (const k of work.settled.keys()) {
      if (!this.#settled.has(k)) charge(k.slice(0, k.indexOf(":")), storageBytes.settled(k.slice(k.indexOf(":") + 1)));
    }
    for (const acct of credited.keys()) {
      const payer = firstPayer.get(acct)!;
      if (!this.#credits.has(acct)) charge(payer, storageBytes.credit(acct, { budget: payer }));
    }
    for (const id of [...charged.keys()].sort()) {
      if ((this.#reserved.get(id) ?? 0) < charged.get(id)!) {
        throw new ChainError("INSUFFICIENT_RESERVE", `Budget ${id} has ${this.#reserved.get(id) ?? 0} bytes of storage reserve, the batch needs ${charged.get(id)}`);
      }
    }
    this.#chargeStorage(caller, storageBytes.batch(caller));

    for (const [id, bytes] of charged) this.#reserved.set(id, this.#reserved.get(id)! - bytes);
    this.#commit(work);
    for (const [id, d] of debited) this.#budgets.get(id)!.escrow -= d;
    for (const [acct, c] of credited) this.#addCredit(acct, c, { budget: firstPayer.get(acct)! });
    this.#batches.set(batchKey(caller, a.batchId), { root: a.root, settler: caller, gross, net, at: this.#now });
    return this.#tx();
  }

  /**
   * The escape hatch: a payee settles its own latest voucher, with no settler and no offset. It needs the node's
   * acceptance of that exact call, by a receipt key the Budget's settler registered, dated no later than the Budget's
   * revoke or expiry. `depositYocto` pays for new storage once the Budget's prepaid reserve is used up.
   */
  async settleOwn(caller: AccountId, c: Claim, acceptance: Acceptance, depositYocto = 0n): Promise<TxHash> {
    const b = this.#mustBudget(c.budgetId);
    if (c.payee !== caller) throw new ChainError("NOT_PAYEE");
    if (caller === b.owner) throw new ChainError("PAYEE_IS_OWNER", b.owner);
    if (this.#now > settleDeadline(b)) throw new ChainError("BUDGET_CLOSED", b.id);
    const work = this.#workspace();
    const delta = this.#claimDelta(work, b, c);
    if (!(this.#receiptKeys.get(b.settler) ?? []).includes(acceptance.nodeKey)) throw new ChainError("ACCEPTANCE_KEY_UNKNOWN", `${acceptance.nodeKey} is not a receipt key of ${b.settler}`);
    if (!acceptanceSignedFor(c, acceptance)) throw new ChainError("BAD_ACCEPTANCE", b.id);
    if (!acceptanceInTime(acceptance, b)) throw new ChainError("ACCEPTANCE_TOO_LATE", `accepted at ${acceptance.timestampS} s`);
    this.#applyDelta(work, b, c, delta);
    if (b.escrow < delta) throw new ChainError("INSUFFICIENT_ESCROW", b.owner);

    const key = settledKey(c.budgetId, c.payee);
    const reserved = this.#reserved.get(b.id) ?? 0;
    // A new credit entry is the Budget's when its reserve covers a whole pair; otherwise the payee helps pay for it.
    const funder: CreditFunder = reserved >= PAIR_BYTES ? { budget: b.id } : null;
    const grown = (this.#settled.has(key) ? 0 : storageBytes.settled(c.payee)) + (this.#credits.has(caller) ? 0 : storageBytes.credit(caller, funder));
    const fromReserve = Math.min(grown, reserved);
    const charged = storageCost(grown - fromReserve);
    if (depositYocto < charged) throw new ChainError("INSUFFICIENT_DEPOSIT", `${depositYocto} < ${charged}`);

    this.#reserved.set(b.id, reserved - fromReserve);
    this.#commit(work);
    b.escrow -= delta;
    this.#addCredit(caller, delta, funder);
    return this.#tx();
  }

  // ---- Chain ----

  async budget(id: Id32): Promise<Budget | null> {
    const b = this.#budgets.get(id);
    return b ? { ...structuredClone(b), storageReserveBytes: BigInt(this.#reserved.get(id) ?? 0) } : null;
  }

  async settledOf(budgetId: Id32, payee: AccountId): Promise<bigint> {
    return this.#settled.get(settledKey(budgetId, payee)) ?? 0n;
  }

  async creditOf(account: AccountId): Promise<bigint> {
    return this.#credits.get(account)?.amount ?? 0n;
  }

  async balanceOf(account: AccountId): Promise<bigint> {
    return this.#bal(account);
  }

  async batch(id: Id32, settler: AccountId): Promise<Batch | null> {
    const b = this.#batches.get(batchKey(settler, id));
    return b ? { ...b } : null;
  }

  async payments(ids: readonly Id32[]): Promise<Array<Payment | null>> {
    return ids.map((id) => {
      const p = this.#payments.get(id);
      return p ? { ...p } : null;
    });
  }

  async isRegistered(account: AccountId): Promise<boolean> {
    return this.#registered.has(account);
  }

  async receiptKeys(settler: AccountId): Promise<PublicKey[]> {
    return [...(this.#receiptKeys.get(settler) ?? [])];
  }

  async storageOf(account: AccountId): Promise<bigint> {
    return this.#storage.get(account) ?? 0n;
  }

  settle(args: SettleArgs): Promise<TxHash> {
    return this.settleAs(this.operator, args);
  }

  async payout(accounts: readonly AccountId[]): Promise<TxHash> {
    if (accounts.length > MAX_PAYOUT_ACCOUNTS) throw new ChainError("TOO_MANY_ACCOUNTS", `${accounts.length} > ${MAX_PAYOUT_ACCOUNTS}`);
    for (const account of [...new Set(accounts)].sort(compareAscii)) {
      const credit = this.#credits.get(account);
      if (!credit || credit.amount === 0n || !this.#registered.has(account)) continue;
      const amount = credit.amount;
      credit.amount = 0n;
      if (!this.#transfer(account, amount)) credit.amount += amount;
      this.#releaseCreditIfEmpty(account);
    }
    return this.#tx();
  }

  async txState(hash: TxHash): Promise<TxState> {
    return this.#txs.get(hash) ?? { status: "unknown" };
  }

  async verifyReceipt(batchId: Id32, settler: AccountId, fields: ReceiptFields, proof: readonly Id32[]): Promise<boolean> {
    const b = this.#batches.get(batchKey(settler, batchId));
    return b ? verifyMerkleProof(b.root, receiptLeaf(this.hub, this.network, batchId, fields), proof) : false;
  }

  // ---- internals ----

  #bal(account: AccountId): bigint {
    return this.#balances.get(account) ?? 0n;
  }

  #tx(): TxHash {
    const hash = `fake-tx-${++this.#txSeq}`;
    this.#txs.set(hash, { status: "final" });
    return hash;
  }

  #mustBudget(id: Id32): Budget {
    const b = this.#budgets.get(id);
    if (!b) throw new ChainError("UNKNOWN_BUDGET", id);
    return b;
  }

  /** The hub and the token can never be paid: credit in their name could not be paid out. */
  #isReserved(account: AccountId): boolean {
    return account === this.hub || account === this.token;
  }

  /** Takes the cost of `bytes` from the payer's prepaid storage balance, or refuses. The hub never pays. */
  #chargeStorage(payer: AccountId, bytes: number): void {
    const cost = storageCost(bytes);
    if (cost === 0n) return;
    const balance = this.#storage.get(payer) ?? 0n;
    if (balance < cost) throw new ChainError("INSUFFICIENT_STORAGE", `${payer} has ${balance} yoctoNEAR of storage balance, the call needs ${cost}`);
    this.#storage.set(payer, balance - cost);
  }

  #addCredit(account: AccountId, amount: bigint, funder: CreditFunder): void {
    const entry = this.#credits.get(account);
    if (entry) entry.amount += amount;
    else this.#credits.set(account, { amount, funder });
  }

  /**
   * Removes a credit entry that holds nothing, and returns the storage it frees to whoever paid for it: a settler's
   * storage balance or a Budget's reserve. An entry a `settle_own` caller's deposit helped pay for has nobody to
   * return to: that stays with the hub.
   */
  #releaseCreditIfEmpty(account: AccountId): void {
    const entry = this.#credits.get(account);
    if (!entry || entry.amount !== 0n) return;
    this.#credits.delete(account);
    const bytes = storageBytes.credit(account, entry.funder);
    if (entry.funder === null) return;
    if ("settler" in entry.funder) {
      const settler = entry.funder.settler;
      if (this.#storage.has(settler)) this.#storage.set(settler, this.#storage.get(settler)! + storageCost(bytes));
    } else if (this.#reserved.has(entry.funder.budget)) {
      this.#reserved.set(entry.funder.budget, this.#reserved.get(entry.funder.budget)! + bytes);
    }
  }

  /** The promise-with-callback shape of `ft_transfer`: in flight first, then settled or rolled back by the caller. */
  #transfer(to: AccountId, amount: bigint): boolean {
    this.#inFlight += amount;
    const fails = this.#failTransferTo.delete(to) || !this.#registered.has(to);
    this.#inFlight -= amount;
    if (fails) return false;
    this.#balances.set(this.hub, this.#bal(this.hub) - amount);
    this.#balances.set(to, this.#bal(to) + amount);
    return true;
  }

  #workspace(): Workspace {
    return { settled: new Map(), spent: new Map() };
  }

  #commit(work: Workspace) {
    for (const [k, v] of work.settled) this.#settled.set(k, v);
    for (const [id, v] of work.spent) this.#budgets.get(id)!.spent = v;
  }

  /** The checks on the voucher itself, in the hub's order: reserved payee, payee list, signature, staleness, step. Returns the delta. */
  #claimDelta(work: Workspace, b: Budget, c: Claim): bigint {
    if (this.#isReserved(c.payee)) throw new ChainError("RESERVED_ACCOUNT", c.payee);
    if (b.payees.length > 0 && !b.payees.includes(c.payee)) throw new ChainError("PAYEE_NOT_ALLOWED", c.payee);
    const digest = voucherDigest(this.hub, this.network, c);
    if (!verifyDigest(b.agentPk, digest, c.signature)) throw new ChainError("BAD_SIGNATURE", b.id);
    const key = settledKey(c.budgetId, c.payee);
    const settled = work.settled.get(key) ?? this.#settled.get(key) ?? 0n;
    if (c.cumulative <= settled) throw new ChainError("STALE_VOUCHER", key);
    const delta = c.cumulative - settled;
    // `cumulative` is the authority: the signed price of the last call can be below the step, never above it.
    if (c.amount > delta) throw new ChainError("AMOUNT_ABOVE_STEP", `${c.amount} > ${delta}`);
    return delta;
  }

  /** The cap check, recording new state only in the workspace. */
  #applyDelta(work: Workspace, b: Budget, c: Claim, delta: bigint): bigint {
    const spent = (work.spent.get(b.id) ?? b.spent) + delta;
    if (spent > b.cap) throw new ChainError("CAP_EXCEEDED", b.id);
    work.settled.set(settledKey(c.budgetId, c.payee), c.cumulative);
    work.spent.set(b.id, spent);
    return delta;
  }

  /** `ft_on_transfer`: true keeps the tokens; false returns the full amount. Bad messages never panic. */
  #onTransfer(sender: AccountId, amount: bigint, msg: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg);
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null) return false;
    const { budget, payment } = parsed as { budget?: { budget_id?: unknown }; payment?: Record<string, unknown> };
    if (budget !== undefined) {
      const b = typeof budget.budget_id === "string" ? this.#budgets.get(budget.budget_id) : undefined;
      if (!b || b.owner !== sender || b.revokedAt !== null || this.#now > b.validUntil) return false;
      b.escrow += amount;
      return true;
    }
    if (payment !== undefined) return this.#onPayment(sender, amount, payment);
    return false;
  }

  #onPayment(sender: AccountId, amount: bigint, p: Record<string, unknown>): boolean {
    const checkout = this.#checkout;
    if (!checkout) return false;
    let terms;
    try {
      terms = { paymentId: String(p.payment_id), merchant: String(p.merchant), amount: BigInt(String(p.amount)), expiryMs: BigInt(String(p.expiry_ms)) };
      if (terms.amount !== amount || this.#now > terms.expiryMs || this.#payments.has(terms.paymentId) || this.#isReserved(terms.merchant)) return false;
      if (!verifyDigest(checkout.key, checkoutDigest(this.hub, this.network, terms), String(p.signature))) return false;
    } catch {
      return false;
    }
    // The settler that signed the terms pays for the record. Without the balance the hub panics with
    // INSUFFICIENT_STORAGE, and the token then returns the payment to the payer: the same outcome as a refusal.
    const bytes = storageBytes.payment(terms.merchant, sender) + (this.#credits.has(terms.merchant) ? 0 : storageBytes.credit(terms.merchant, { settler: checkout.settler }));
    try {
      this.#chargeStorage(checkout.settler, bytes);
    } catch {
      return false;
    }
    this.#payments.set(terms.paymentId, { id: terms.paymentId, merchant: terms.merchant, amount, payer: sender, at: this.#now });
    this.#addCredit(terms.merchant, amount, { settler: checkout.settler });
    return true;
  }
}

/** The hub's "full key" rule: exactly one yoctoNEAR attached, which a function-call access key cannot attach. */
function oneYocto(attached: bigint): void {
  if (attached !== 1n) throw new ChainError("ONE_YOCTO_REQUIRED", "Requires attached deposit of exactly 1 yoctoNEAR");
}
