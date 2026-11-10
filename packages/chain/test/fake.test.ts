import { describe, expect, it } from "vitest";
import { FAKE_SETTLER_STORAGE, FakeChain } from "../src/fake.ts";
import {
  HUB_ERRORS,
  computeNetting,
  keypairFromSeed,
  ChainError,
  MAX_CLAIMS,
  MAX_PAYOUT_ACCOUNTS,
  MAX_RECEIPT_KEYS,
  PAIR_BYTES,
  MAX_ANY_PAYEES,
  MAX_PRUNE_PAYEES,
  EXPIRY_GRACE_MS,
  budgetTermsArgs,
  pruneTx,
  proposeAdminTx,
  acceptAdminTx,
  REVOKE_GRACE_MS,
  acceptanceArgs,
  checkoutDigest,
  fundStorageTx,
  publicKeyBytes,
  publicKeyToString,
  registerReceiptKeyTx,
  settleOwnTx,
  signAcceptance,
  signDigest,
  storageBytes,
  storageCost,
  toHex,
  voucherDigest,
  withdrawStorageTx,
  buildReceiptTree,
  fundFromCreditTx,
  acceptCheckoutTx,
  setMinPaymentTx,
  DEFAULT_MIN_PAYMENT,
  MAX_VALID_UNTIL_MS,
  type Acceptance,
  type BudgetTerms,
  type Claim,
  type Keypair,
} from "../src/index.ts";

const HUB = "hub.testnet";
const NET = "near:testnet" as const;
const NODE = "node.testnet";
const A = "a.testnet";
const B = "b.testnet";
const C = "c.testnet";
const S = "seller.testnet";
const ROOT = "ee".repeat(32);
const kp = (n: number) => keypairFromSeed(new Uint8Array(32).fill(n));
const agentA = kp(1);
const agentB = kp(2);
const agentC = kp(3);
/** The key the node signs acceptances with, registered on the hub by `setup`. */
const nodeKey = kp(200);
let seq = 0;
const nextId = () => (++seq).toString(16).padStart(64, "0");
const T0 = 1_800_000_000_000n;

function setup() {
  const c = new FakeChain({ hub: HUB, network: NET, operator: NODE, nowMs: T0 });
  c.addSettler(NODE);
  void c.registerReceiptKey(NODE, nodeKey.publicKey);
  for (const acct of [A, B, C, S]) {
    c.register(acct);
    c.mint(acct, 1_000_000n);
  }
  return c;
}

/** The node's acceptance of `v`, signed at the chain's current time unless another second is given. */
const accept = (c: FakeChain, v: Claim, atS: bigint = c.nowMs / 1000n, key: Keypair = nodeKey): Acceptance => signAcceptance(key, v, atS);

function terms(owner: string, agent: Keypair, over: Partial<BudgetTerms> = {}): BudgetTerms {
  return { owner, agentPk: agent.publicKey, settler: NODE, cap: 1_000n, validUntil: T0 + 86_400_000n, payees: [], policyHash: "aa".repeat(32), salt: nextId(), ...over };
}

function claim(budgetId: string, payee: string, agent: Keypair, amount: bigint, cumulative: bigint): Claim {
  const requestHash = "cd".repeat(32);
  const signature = signDigest(agent.secretKey, voucherDigest(HUB, NET, { budgetId, payee, amount, cumulative, requestHash }));
  return { budgetId, payee, amount, cumulative, requestHash, signature };
}

async function settle(c: FakeChain, claims: Claim[], owners: Record<string, string>, batchId = nextId()) {
  const prior = await Promise.all(claims.map((x) => c.settledOf(x.budgetId, x.payee)));
  const { entries } = computeNetting(claims.map((x, i) => ({ owner: owners[x.budgetId]!, payee: x.payee, delta: x.cumulative - prior[i]! })));
  return c.settle({ batchId, root: ROOT, claims, expectedNet: entries });
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ChainError) return err.code;
    throw err;
  }
  return "OK";
};

function pair(c: FakeChain, escrowA = 100n, escrowB = 100n) {
  const a = c.openBudget(A, terms(A, agentA));
  const b = c.openBudget(B, terms(B, agentB));
  if (escrowA) c.depositBudget(A, a, escrowA);
  if (escrowB) c.depositBudget(B, b, escrowB);
  return { a, b, owners: { [a]: A, [b]: B } };
}

describe("authority and funding are separate", () => {
  it("open_budget sets cap and starts with zero escrow; deposits raise escrow only", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA, { cap: 500n }));
    expect(await c.budget(id)).toMatchObject({ owner: A, cap: 500n, spent: 0n, escrow: 0n, settler: NODE, revokedAt: null });
    c.depositBudget(A, id, 80n);
    expect(await c.budget(id)).toMatchObject({ cap: 500n, escrow: 80n });
    c.solvency();
  });

  it("only the Budget owner can deposit; anyone else is refunded in full", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    const before = await c.balanceOf(B);
    expect(c.ftTransferCall(B, 50n, JSON.stringify({ budget: { budget_id: id } })).refunded).toBe(50n);
    expect(await c.balanceOf(B)).toBe(before);
    expect((await c.budget(id))!.escrow).toBe(0n);
  });

  it("open_budget rejects a duplicate, a zero cap and a past expiry, and non-canonical input", async () => {
    const c = setup();
    const t = terms(A, agentA);
    c.openBudget(A, t);
    expect(() => c.openBudget(A, t)).toThrow(/BUDGET_EXISTS/);
    expect(() => c.openBudget(A, terms(A, agentA, { cap: 0n }))).toThrow(/INVALID_BUDGET/);
    expect(() => c.openBudget(A, terms(A, agentA, { validUntil: T0 - 1n }))).toThrow(/INVALID_BUDGET/);
    expect(() => c.openBudget(B, t)).toThrow(/NOT_OWNER/);
  });

  it("a batch clears more gross than escrow when obligations offset", async () => {
    const c = setup();
    const { a, b, owners } = pair(c, 5n, 5n);
    const claims = [claim(a, B, agentA, 100n, 100n), claim(b, A, agentB, 98n, 98n)];
    await settle(c, claims, owners);
    expect(await c.budget(a)).toMatchObject({ spent: 100n, escrow: 3n });
    expect(await c.budget(b)).toMatchObject({ spent: 98n, escrow: 5n });
    expect(await c.creditOf(B)).toBe(2n);
    expect(await c.creditOf(A)).toBe(0n);
    c.solvency();
  });

  it("the same claims without the offset do not clear on the same escrow", async () => {
    const c = setup();
    const { a, owners } = pair(c, 5n, 5n);
    expect(await code(settle(c, [claim(a, B, agentA, 100n, 100n)], owners))).toBe("INSUFFICIENT_ESCROW");
  });

  it("A owes B 10, B owes A 7: escrow A falls by 3 and B gains a credit of 3", async () => {
    const c = setup();
    const { a, b, owners } = pair(c);
    await settle(c, [claim(a, B, agentA, 10n, 10n), claim(b, A, agentB, 7n, 7n)], owners);
    expect(await c.budget(a)).toMatchObject({ spent: 10n, escrow: 97n });
    expect(await c.budget(b)).toMatchObject({ spent: 7n, escrow: 100n });
    expect(await c.creditOf(B)).toBe(3n);
    c.solvency();
  });

  it("cap limits gross spending even when escrow would allow it", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA, { cap: 50n }));
    c.depositBudget(A, id, 500n);
    expect(await code(settle(c, [claim(id, S, agentA, 51n, 51n)], { [id]: A }))).toBe("CAP_EXCEEDED");
  });

  it("a pure creditor owning no Budget accumulates credit", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 40n);
    await settle(c, [claim(id, S, agentA, 40n, 40n)], { [id]: A });
    expect(await c.creditOf(S)).toBe(40n);
    expect((await c.budget(id))!.escrow).toBe(0n);
    c.solvency();
  });
});

describe("settle_batch rejections", () => {
  it("requires an allowlisted settler", async () => {
    const c = setup();
    const { a, owners } = pair(c);
    const cl = [claim(a, S, agentA, 1n, 1n)];
    const { entries } = computeNetting([{ owner: owners[a]!, payee: S, delta: 1n }]);
    expect(await code(c.settleAs("stranger.testnet", { batchId: nextId(), root: ROOT, claims: cl, expectedNet: entries }))).toBe("NOT_SETTLER");
  });

  it("requires each Budget's settler to be the caller", async () => {
    const c = setup();
    c.addSettler("other-node.testnet");
    const id = c.openBudget(A, terms(A, agentA, { settler: "other-node.testnet" }));
    c.depositBudget(A, id, 10n);
    expect(await code(settle(c, [claim(id, S, agentA, 1n, 1n)], { [id]: A }))).toBe("NOT_BUDGET_SETTLER");
  });

  it("rejects a replayed batch id", async () => {
    const c = setup();
    const { a, owners } = pair(c);
    const batchId = nextId();
    await settle(c, [claim(a, S, agentA, 1n, 1n)], owners, batchId);
    expect(await code(settle(c, [claim(a, S, agentA, 1n, 2n)], owners, batchId))).toBe("BATCH_EXISTS");
    expect(await c.settledOf(a, S)).toBe(1n);
  });

  it("rejects stale vouchers, equal or lower than settled", async () => {
    const c = setup();
    const { a, owners } = pair(c);
    await settle(c, [claim(a, S, agentA, 5n, 5n)], owners);
    const stale = claim(a, S, agentA, 5n, 5n);
    expect(await code(c.settle({ batchId: nextId(), root: ROOT, claims: [stale], expectedNet: [] }))).toBe("STALE_VOUCHER");
    const lower = claim(a, S, agentA, 1n, 4n);
    expect(await code(c.settle({ batchId: nextId(), root: ROOT, claims: [lower], expectedNet: [] }))).toBe("STALE_VOUCHER");
  });

  it("rejects an empty batch", async () => {
    const c = setup();
    expect(await code(c.settle({ batchId: nextId(), root: ROOT, claims: [], expectedNet: [] }))).toBe("ZERO_GROSS");
  });

  it("rejects more than MAX_CLAIMS", async () => {
    const c = setup();
    const { a, owners } = pair(c);
    const cl = Array.from({ length: MAX_CLAIMS + 1 }, (_, i) => claim(a, S, agentA, 1n, BigInt(i + 1)));
    expect(await code(settle(c, cl, owners))).toBe("TOO_MANY_CLAIMS");
  });

  it("rejects a bad signature, including one over a different amount or request", async () => {
    const c = setup();
    const { a, owners } = pair(c);
    const good = claim(a, S, agentA, 3n, 3n);
    expect(await code(settle(c, [{ ...good, amount: 4n }], owners))).toBe("BAD_SIGNATURE");
    expect(await code(settle(c, [{ ...good, requestHash: "00".repeat(32) }], owners))).toBe("BAD_SIGNATURE");
    expect(await code(settle(c, [claim(a, S, agentB, 3n, 3n)], owners))).toBe("BAD_SIGNATURE");
  });

  it("rejects an expected_net that does not match the recomputation", async () => {
    const c = setup();
    const { a } = pair(c);
    const cl = [claim(a, S, agentA, 3n, 3n)];
    expect(await code(c.settle({ batchId: nextId(), root: ROOT, claims: cl, expectedNet: [] }))).toBe("NET_MISMATCH");
    expect(
      await code(
        c.settle({
          batchId: nextId(),
          root: ROOT,
          claims: cl,
          expectedNet: [
            { account: A, debit: 2n, credit: 0n },
            { account: S, debit: 0n, credit: 2n },
          ],
        }),
      ),
    ).toBe("NET_MISMATCH");
  });

  it("allows one Budget per owner per batch", async () => {
    const c = setup();
    const a1 = c.openBudget(A, terms(A, agentA));
    const a2 = c.openBudget(A, terms(A, agentC));
    c.depositBudget(A, a1, 10n);
    c.depositBudget(A, a2, 10n);
    expect(await code(settle(c, [claim(a1, S, agentA, 1n, 1n), claim(a2, S, agentC, 1n, 1n)], { [a1]: A, [a2]: A }))).toBe("ONE_BUDGET_PER_OWNER");
  });

  it("enforces the on-chain payee list", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA, { payees: [S] }));
    c.depositBudget(A, id, 10n);
    expect(await code(settle(c, [claim(id, "attacker.testnet", agentA, 1n, 1n)], { [id]: A }))).toBe("PAYEE_NOT_ALLOWED");
    expect(await code(settle(c, [claim(id, S, agentA, 1n, 1n)], { [id]: A }))).toBe("OK");
  });

  it("leaves no partial state after a rejected batch", async () => {
    const c = setup();
    const { a, b, owners } = pair(c, 100n, 1n);
    const bad = [claim(a, S, agentA, 10n, 10n), claim(b, S, agentB, 50n, 50n)];
    expect(await code(settle(c, bad, owners))).toBe("INSUFFICIENT_ESCROW");
    expect(await c.budget(a)).toMatchObject({ spent: 0n, escrow: 100n });
    expect(await c.settledOf(a, S)).toBe(0n);
    expect(await c.creditOf(S)).toBe(0n);
  });

  it("exposes error codes as a closed list", () => {
    expect(HUB_ERRORS).toContain("BAD_SIGNATURE");
  });
});

describe("batches and proofs", () => {
  it("stores root, settler, gross, net and time, and verifies a receipt", async () => {
    const c = setup();
    const { a, b, owners } = pair(c);
    const batchId = nextId();
    const cl = claim(a, B, agentA, 10n, 10n);
    const back = claim(b, A, agentB, 7n, 7n);
    const f = { callId: "01".repeat(32), budgetId: a, payee: B, amount: 10n, cumulative: 10n, requestHash: cl.requestHash, timestampMs: T0, voucherSig: cl.signature };
    const tree = buildReceiptTree(HUB, NET, batchId, [f]);
    const { entries } = computeNetting([
      { owner: A, payee: B, delta: 10n },
      { owner: B, payee: A, delta: 7n },
    ]);
    const tx = await c.settle({ batchId, root: tree.root, claims: [cl, back], expectedNet: entries });
    expect(await c.batch(batchId, NODE)).toEqual({ root: tree.root, settler: NODE, gross: 17n, net: 3n, at: T0 });
    expect(await c.batch(batchId, "other-node.testnet")).toBeNull();
    expect(await c.txState(tx)).toEqual({ status: "final" });
    expect(await c.verifyReceipt(batchId, NODE, f, tree.proofOf(f.callId))).toBe(true);
    expect(await c.verifyReceipt(batchId, NODE, { ...f, amount: 11n }, tree.proofOf(f.callId))).toBe(false);
    // The batch id is the node's: under another settler's name it proves nothing.
    expect(await c.verifyReceipt(batchId, "other-node.testnet", f, tree.proofOf(f.callId))).toBe(false);
    expect(owners[a]).toBe(A);
    expect(await c.txState("no-such-tx")).toEqual({ status: "unknown" });
  });

  it("returns null for an unknown batch", async () => {
    expect(await setup().batch("00".repeat(32), NODE)).toBeNull();
  });
});

describe("credits and payout", () => {
  async function credited() {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    await settle(c, [claim(id, S, agentA, 40n, 40n)], { [id]: A });
    return c;
  }

  it("zeroes credit and pays the token", async () => {
    const c = await credited();
    const before = await c.balanceOf(S);
    await c.payout([S]);
    expect(await c.creditOf(S)).toBe(0n);
    expect(await c.balanceOf(S)).toBe(before + 40n);
    c.solvency();
  });

  it("leaves an unregistered payee's credit waiting", async () => {
    const c = await credited();
    c.unregister(S);
    await c.payout([S]);
    expect(await c.creditOf(S)).toBe(40n);
    expect(await c.isRegistered(S)).toBe(false);
    c.solvency();
  });

  it("restores credit when the transfer fails", async () => {
    const c = await credited();
    const before = await c.balanceOf(S);
    c.failNextTransferTo(S);
    await c.payout([S]);
    expect(await c.creditOf(S)).toBe(40n);
    expect(await c.balanceOf(S)).toBe(before);
    c.solvency();
  });

  it("caps payout at 10 accounts", async () => {
    const c = setup();
    await expect(c.payout(Array.from({ length: MAX_PAYOUT_ACCOUNTS + 1 }, (_, i) => `p${i}.testnet`))).rejects.toThrow(/TOO_MANY_ACCOUNTS/);
  });
});

describe("settle_own", () => {
  it("lets the payee settle its latest voucher, with the node's acceptance, when the node is gone", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    const v = claim(id, S, agentA, 30n, 30n);
    await c.settleOwn(S, v, accept(c, v));
    expect(await c.budget(id)).toMatchObject({ spent: 30n, escrow: 70n });
    expect(await c.creditOf(S)).toBe(30n);
    expect(await c.settledOf(id, S)).toBe(30n);
    c.solvency();
  });

  it("only the named payee may call it, and it respects escrow, staleness and signature", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 10n);
    const v = claim(id, S, agentA, 5n, 5n);
    const big = claim(id, S, agentA, 20n, 20n);
    expect(await code(c.settleOwn(B, v, accept(c, v)))).toBe("NOT_PAYEE");
    expect(await code(c.settleOwn(S, big, accept(c, big)))).toBe("INSUFFICIENT_ESCROW");
    expect(await code(c.settleOwn(S, { ...v, amount: 6n }, accept(c, v)))).toBe("BAD_SIGNATURE");
    await c.settleOwn(S, v, accept(c, v));
    expect(await code(c.settleOwn(S, v, accept(c, v)))).toBe("STALE_VOUCHER");
  });

  it("F1: an owner cannot settle a voucher to itself, or to an accomplice, ahead of the seller the node accepted", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    const served = claim(id, S, agentA, 60n, 60n);
    const servedAcceptance = accept(c, served);

    // The owner chose the agent key, so it can sign anything. To itself is refused even with a real acceptance.
    const toSelf = claim(id, A, agentA, 100n, 100n);
    expect(await code(c.settleOwn(A, toSelf, accept(c, toSelf)))).toBe("PAYEE_IS_OWNER");
    // To an accomplice: the node never accepted that call, so there is no acceptance to show.
    const toAccomplice = claim(id, C, agentA, 100n, 100n);
    expect(await code(c.settleOwn(C, toAccomplice, accept(c, toAccomplice, undefined, agentA)))).toBe("ACCEPTANCE_KEY_UNKNOWN");
    expect(await code(c.settleOwn(C, toAccomplice, { ...accept(c, toAccomplice, undefined, agentA), nodeKey: nodeKey.publicKey }))).toBe("BAD_ACCEPTANCE");
    expect(await code(c.settleOwn(C, toAccomplice, servedAcceptance))).toBe("BAD_ACCEPTANCE");
    expect((await c.budget(id))!.escrow).toBe(100n);

    await c.settleOwn(S, served, servedAcceptance);
    expect(await c.creditOf(S)).toBe(60n);
    c.solvency();
  });

  it("F2: a leaked agent key cannot settle a voucher after the revoke or the expiry", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 500n);
    const served = claim(id, S, agentA, 30n, 30n);
    const servedAcceptance = accept(c, served);
    c.advance(5_000n);
    await c.revokeBudget(A, id);
    const revokedS = c.nowMs / 1000n;
    c.advance(59n * 60n * 1000n);

    const stolen = claim(id, C, agentA, 500n, 500n);
    expect(await code(c.settleOwn(C, stolen, servedAcceptance))).toBe("BAD_ACCEPTANCE");
    // Even the node's own key does not help when the acceptance is dated after the revoke.
    expect(await code(c.settleOwn(C, stolen, accept(c, stolen, revokedS + 1n)))).toBe("ACCEPTANCE_TOO_LATE");
    expect(await code(c.settleOwn(C, stolen, accept(c, stolen)))).toBe("ACCEPTANCE_TOO_LATE");
    expect((await c.budget(id))!.escrow).toBe(500n);
    // The call the node accepted before the revoke still settles inside the grace period.
    await c.settleOwn(S, served, servedAcceptance);
    expect(await c.creditOf(S)).toBe(30n);

    // Expiry: an acceptance dated after `validUntil` is refused all through the three-day grace.
    const d = setup();
    const t = terms(A, agentA);
    const id2 = d.openBudget(A, t);
    d.depositBudget(A, id2, 500n);
    d.advance(2n * 86_400_000n);
    const late = claim(id2, C, agentA, 500n, 500n);
    expect(await code(d.settleOwn(C, late, accept(d, late, t.validUntil / 1000n + 1n)))).toBe("ACCEPTANCE_TOO_LATE");
    await d.settleOwn(C, late, accept(d, late, t.validUntil / 1000n));
    expect(await d.creditOf(C)).toBe(500n);
  });

  it("compares the acceptance second with the revoke in milliseconds: the second of the revoke still settles", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 500n);
    c.advance(7_250n);
    await c.revokeBudget(A, id);
    const revokedS = c.nowMs / 1000n;
    expect(c.nowMs % 1000n).toBe(250n);
    const before = claim(id, S, agentA, 1n, 1n);
    await c.settleOwn(S, before, accept(c, before, revokedS - 1n));
    const same = claim(id, S, agentA, 1n, 2n);
    await c.settleOwn(S, same, accept(c, same, revokedS));
    const after = claim(id, S, agentA, 1n, 3n);
    expect(await code(c.settleOwn(S, after, accept(c, after, revokedS + 1n)))).toBe("ACCEPTANCE_TOO_LATE");
    // A timestamp too large for milliseconds in a u64 is late, never an overflow that wraps around.
    expect(await code(c.settleOwn(S, after, accept(c, after, 2n ** 64n - 1n)))).toBe("ACCEPTANCE_TOO_LATE");
    expect(await code(c.settleOwn(S, after, accept(c, after, (2n ** 64n - 1n) / 1000n + 1n)))).toBe("ACCEPTANCE_TOO_LATE");
  });

  it("an acceptance covers exactly one claim, and must come from the Budget's own settler", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 500n);
    const v = claim(id, S, agentA, 10n, 10n);
    const accepted = accept(c, v);
    for (const other of [claim(id, S, agentA, 9n, 10n), claim(id, S, agentA, 10n, 11n), claim(id, C, agentA, 10n, 10n)]) {
      expect(await code(c.settleOwn(other.payee, other, accepted))).toBe("BAD_ACCEPTANCE");
    }
    expect(await code(c.settleOwn(S, v, { ...accepted, timestampS: accepted.timestampS - 1n }))).toBe("BAD_ACCEPTANCE");

    // Another allowlisted settler's key cannot vouch for a Budget that names the node.
    const otherKey = kp(201);
    c.addSettler("other-node.testnet");
    await c.registerReceiptKey("other-node.testnet", otherKey.publicKey);
    expect(await code(c.settleOwn(S, v, accept(c, v, undefined, otherKey)))).toBe("ACCEPTANCE_KEY_UNKNOWN");
    await c.settleOwn(S, v, accepted);
    expect(await c.creditOf(S)).toBe(10n);
  });

  it("draws every new payee from the Budget's prepaid reserve, up to the payees it declared", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA, { cap: 1_000_000n }));
    c.depositBudget(A, id, 1_000n);
    expect(c.storageReserve(id)).toBe(16 * PAIR_BYTES);
    for (let i = 0; i < 16; i++) {
      const payee = `p${String(i).padStart(2, "0")}.testnet`;
      const reserve = c.storageReserve(id);
      const v = claim(id, payee, agentA, 1n, 1n);
      await c.settleOwn(payee, v, accept(c, v));
      expect(c.storageReserve(id)).toBe(reserve - storageBytes.settled(payee) - storageBytes.credit(payee, { budget: id }));
    }
    expect((await c.budget(id))!.payeesPaid).toBe(16);
    // One payee more than the owner declared is refused, whatever it attaches.
    const extra = claim(id, "pxx.testnet", agentA, 1n, 1n);
    expect(await code(c.settleOwn("pxx.testnet", extra, accept(c, extra), 10n ** 24n))).toBe("TOO_MANY_PAYEES");
    // A repeat payee writes nothing new, so it needs no deposit.
    const again = claim(id, "p00.testnet", agentA, 1n, 2n);
    await c.settleOwn("p00.testnet", again, accept(c, again));
    c.solvency();
  });

  it("P1: a credit entry the reserve cannot cover is paid by the payee alone, and one it covers is the Budget's", async () => {
    const c = setup();
    const long = "7".padStart(64, "0");
    const id = c.openBudget(A, terms(A, agentA, { cap: 1_000_000n, payees: [long] }));
    c.depositBudget(A, id, 1_000n);
    c.register(long);
    await settle(c, [claim(id, long, agentA, 1n, 1n)], { [id]: A });
    expect(c.storageReserve(id)).toBe(0);
    await c.payout([long]);
    // The credit entry's bytes came back, so the payee's own settlement is paid from the reserve again, for the Budget.
    expect(c.storageReserve(id)).toBe(storageBytes.credit(long, { budget: id }));
    const v = claim(id, long, agentA, 1n, 2n);
    await c.settleOwn(long, v, accept(c, v));
    expect(c.storageReserve(id)).toBe(0);
    await c.payout([long]);
    expect(c.storageReserve(id)).toBe(storageBytes.credit(long, { budget: id }));
    // And the node's next batch still settles: no byte leaked.
    await settle(c, [claim(id, long, agentA, 1n, 3n)], { [id]: A });
    c.solvency();
  });

  it("builds the settler's transactions with the hub's method names and deposits", () => {
    expect(registerReceiptKeyTx(HUB, nodeKey.publicKey).actions[0]!.params).toMatchObject({ methodName: "register_receipt_key", args: { key: toHex(publicKeyBytes(nodeKey.publicKey)) }, deposit: "1" });
    expect(fundStorageTx(HUB, NODE, 5n * 10n ** 24n).actions[0]!.params).toMatchObject({ methodName: "fund_storage", args: { account: NODE }, deposit: "5000000000000000000000000" });
    expect(withdrawStorageTx(HUB, 7n).actions[0]!.params).toMatchObject({ methodName: "withdraw_storage", args: { amount: "7" }, deposit: "1" });
  });
});

describe("storage is never paid by the hub", () => {
  it("F4: settle_batch charges each Budget's reserve for its new pairs and the settler for its batch record only", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA, { maxPayees: 20 }));
    c.depositBudget(A, id, 100n);
    const payees = Array.from({ length: 20 }, (_, i) => `payee-${i}.testnet`);
    const before = await c.storageOf(NODE);
    const reserve = c.storageReserve(id);
    await settle(c, payees.map((p) => claim(id, p, agentA, 1n, 1n)), { [id]: A });
    const bytes = payees.reduce((sum, p) => sum + storageBytes.settled(p) + storageBytes.credit(p, { budget: id }), 0);
    expect(reserve - c.storageReserve(id)).toBe(bytes);
    expect(before - (await c.storageOf(NODE))).toBe(storageCost(storageBytes.batch(NODE)));

    // The next voucher for the same pairs overwrites, so only the batch record is new.
    const mid = await c.storageOf(NODE);
    const midReserve = c.storageReserve(id);
    await settle(c, payees.map((p) => claim(id, p, agentA, 1n, 2n)), { [id]: A });
    expect(mid - (await c.storageOf(NODE))).toBe(storageCost(storageBytes.batch(NODE)));
    expect(c.storageReserve(id)).toBe(midReserve);
    c.solvency();
  });

  it("F4 and P4: a Budget cannot pay more distinct payees than it declared, and the whole batch fails with TOO_MANY_PAYEES", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA, { maxPayees: 1 }));
    c.depositBudget(A, id, 100n);
    const long = (n: number) => n.toString(16).padStart(64, "0");
    await settle(c, [claim(id, long(1), agentA, 1n, 1n)], { [id]: A });
    expect(c.storageReserve(id)).toBe(0);
    const batchId = nextId();
    expect(await code(settle(c, [claim(id, long(2), agentA, 1n, 1n)], { [id]: A }, batchId))).toBe("TOO_MANY_PAYEES");
    expect(await c.batch(batchId, NODE)).toBeNull();
    expect(await c.settledOf(id, long(2))).toBe(0n);
    // A payee the Budget already pays costs nothing new.
    await settle(c, [claim(id, long(1), agentA, 1n, 2n)], { [id]: A });
  });

  it("F4: the credit entry of a payee is paid by the Budget whose claim reached it first", async () => {
    const c = setup();
    const { a, b, owners } = pair(c);
    const ra = c.storageReserve(a);
    const rb = c.storageReserve(b);
    await settle(c, [claim(a, S, agentA, 5n, 5n), claim(b, S, agentB, 5n, 5n)], owners);
    expect(ra - c.storageReserve(a)).toBe(storageBytes.settled(S) + storageBytes.credit(S, { budget: a }));
    expect(rb - c.storageReserve(b)).toBe(storageBytes.settled(S));
    // Paid out, the entry's bytes go back to the reserve that paid.
    await c.payout([S]);
    expect(ra - c.storageReserve(a)).toBe(storageBytes.settled(S));
    c.solvency();
  });

  it("F3: a settler with no storage balance cannot settle, and nothing changes; anyone can fund it", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    await c.withdrawStorage(NODE, await c.storageOf(NODE));
    expect(await c.storageOf(NODE)).toBe(0n);
    const v = claim(id, S, agentA, 10n, 10n);
    const batchId = nextId();
    expect(await code(settle(c, [v], { [id]: A }, batchId))).toBe("INSUFFICIENT_STORAGE");
    expect(await c.batch(batchId, NODE)).toBeNull();
    expect(await c.budget(id)).toMatchObject({ spent: 0n, escrow: 100n });
    expect(await c.creditOf(S)).toBe(0n);

    await c.fundStorage(NODE, storageCost(1_000));
    await settle(c, [v], { [id]: A }, batchId);
    expect(await c.creditOf(S)).toBe(10n);
  });

  it("F3: payout removes an emptied credit entry and returns its storage to the Budget that paid for it", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    const start = await c.storageOf(NODE);
    const reserve = c.storageReserve(id);
    await settle(c, [claim(id, S, agentA, 40n, 40n)], { [id]: A });

    // A failed transfer restores the credit into the entry that is still there.
    c.failNextTransferTo(S);
    await c.payout([S]);
    expect(await c.creditOf(S)).toBe(40n);
    expect(c.hasCreditEntry(S)).toBe(true);

    await c.payout([S]);
    expect(c.hasCreditEntry(S)).toBe(false);
    // What the Budget and the settler have paid in the end is what is still stored: the settled entry and the batch record.
    expect(reserve - c.storageReserve(id)).toBe(storageBytes.settled(S));
    expect(start - (await c.storageOf(NODE))).toBe(storageCost(storageBytes.batch(NODE)));
    c.solvency();
  });

  it("F3: storage freed from a settle_own entry goes back to the Budget's reserve, never to the settler", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    const v = claim(id, S, agentA, 10n, 10n);
    await c.settleOwn(S, v, accept(c, v));
    const before = await c.storageOf(NODE);
    const reserve = c.storageReserve(id);
    await c.payout([S]);
    expect(c.hasCreditEntry(S)).toBe(false);
    expect(c.storageReserve(id)).toBe(reserve + storageBytes.credit(S, { budget: id }));
    expect(await c.storageOf(NODE)).toBe(before);
    expect(await c.storageOf(S)).toBe(0n);
  });

  it("the first deposit pays for the balance entry, and only the account itself withdraws", async () => {
    const c = setup();
    const other = "other-node.testnet";
    expect(await code(c.fundStorage(other, 0n))).toBe("ZERO_AMOUNT");
    expect(await code(c.fundStorage(other, 1n))).toBe("INSUFFICIENT_DEPOSIT");
    // The hub and the token could never withdraw a balance.
    expect(await code(c.fundStorage(HUB, 10n ** 24n))).toBe("RESERVED_ACCOUNT");
    expect(await code(c.fundStorage(c.token, 10n ** 24n))).toBe("RESERVED_ACCOUNT");
    await c.fundStorage(other, 10n ** 24n);
    const entry = storageCost(storageBytes.storageBalance(other));
    expect(await c.storageOf(other)).toBe(10n ** 24n - entry);
    await c.fundStorage(other, 5n);
    expect(await c.storageOf(other)).toBe(10n ** 24n - entry + 5n);

    expect(await code(c.withdrawStorage(S, 1n))).toBe("INSUFFICIENT_STORAGE");
    expect(await code(c.withdrawStorage(other, 0n))).toBe("ZERO_AMOUNT");
    await expect(c.withdrawStorage(other, 1n, 0n)).rejects.toMatchObject({ code: "ONE_YOCTO_REQUIRED" });
    expect(await code(c.withdrawStorage(other, 10n ** 24n))).toBe("INSUFFICIENT_STORAGE");
    await c.withdrawStorage(other, await c.storageOf(other));
    expect(await c.storageOf(other)).toBe(0n);
    expect(FAKE_SETTLER_STORAGE).toBeGreaterThan(0n);
  });
});

describe("F7: the hub and the token are never payees or merchants", () => {
  it("refuses them in a batch, in settle_own, in a Budget's payee list and as a checkout merchant", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    for (const reserved of [HUB, c.token]) {
      const v = claim(id, reserved, agentA, 10n, 10n);
      expect(await code(settle(c, [v], { [id]: A }))).toBe("RESERVED_ACCOUNT");
      expect(await code(c.settleOwn(reserved, v, accept(c, v)))).toBe("RESERVED_ACCOUNT");
      expect(() => c.openBudget(B, terms(B, agentB, { payees: [S, reserved] }))).toThrow(/INVALID_BUDGET/);
      expect(await c.creditOf(reserved)).toBe(0n);
    }
    const key = kp(50);
    c.setCheckoutKey(key.publicKey);
    for (const [i, merchant] of [HUB, c.token].entries()) {
      const t = { paymentId: `${i}`.repeat(64), merchant, amount: 25n, expiryMs: T0 + 1000n };
      const msg = JSON.stringify({ payment: { payment_id: t.paymentId, merchant, amount: "25", expiry_ms: t.expiryMs.toString(), signature: signDigest(key.secretKey, checkoutDigest(HUB, NET, t)) } });
      expect(c.ftTransferCall(B, 25n, msg)).toEqual({ refunded: 25n });
    }
    c.solvency();
  });
});

describe("revoke and reclaim", () => {
  it("keeps settlement open through the grace period, then refuses it and lets the owner reclaim", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    await c.revokeBudget(A, id);
    expect((await c.budget(id))!.revokedAt).toBe(T0);
    await settle(c, [claim(id, S, agentA, 10n, 10n)], { [id]: A });
    expect(await code(c.reclaim(A, id))).toBe("TOO_EARLY");
    c.advance(REVOKE_GRACE_MS + 1n);
    expect(await code(settle(c, [claim(id, S, agentA, 5n, 15n)], { [id]: A }))).toBe("BUDGET_CLOSED");
    const before = await c.balanceOf(A);
    await c.reclaim(A, id);
    expect(await c.balanceOf(A)).toBe(before + 90n);
    expect((await c.budget(id))!.escrow).toBe(0n);
    c.solvency();
  });

  it("only the owner can revoke or reclaim, and a revoked Budget takes no deposit", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    expect(await code(c.revokeBudget(B, id))).toBe("NOT_OWNER");
    await c.revokeBudget(A, id);
    expect(await code(c.revokeBudget(A, id))).toBe("ALREADY_REVOKED");
    expect(c.ftTransferCall(A, 5n, JSON.stringify({ budget: { budget_id: id } })).refunded).toBe(5n);
    expect(await code(c.reclaim(B, id))).toBe("NOT_OWNER");
  });

  it("restores escrow when a reclaim transfer fails", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    await c.revokeBudget(A, id);
    c.advance(REVOKE_GRACE_MS + 1n);
    c.failNextTransferTo(A);
    await c.reclaim(A, id);
    expect((await c.budget(id))!.escrow).toBe(100n);
    c.solvency();
  });

  it("an expired Budget settles through the expiry grace and then closes", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA, { validUntil: T0 + 1000n }));
    c.depositBudget(A, id, 100n);
    c.advance(2000n);
    expect(await code(settle(c, [claim(id, S, agentA, 1n, 1n)], { [id]: A }))).toBe("OK");
    c.advance(3n * 86_400_000n);
    expect(await code(settle(c, [claim(id, S, agentA, 1n, 2n)], { [id]: A }))).toBe("BUDGET_CLOSED");
  });
});

describe("checkout payments", () => {
  function shop() {
    const c = setup();
    const key = kp(50);
    c.setCheckoutKey(key.publicKey);
    // These tests use small amounts; the hub's default minimum is 10 000 base units.
    c.setMinPayment(1n);
    return { c, key };
  }
  const terms2 = (over = {}) => ({ paymentId: nextId(), merchant: S, amount: 25n, expiryMs: T0 + 1000n, ...over });
  const msg = (key: Keypair, t: ReturnType<typeof terms2>) =>
    JSON.stringify({
      payment: { payment_id: t.paymentId, merchant: t.merchant, amount: t.amount.toString(), expiry_ms: t.expiryMs.toString(), signature: signDigest(key.secretKey, checkoutDigest(HUB, NET, t)) },
    });

  it("records the payment, credits the merchant and exposes it to the poller", async () => {
    const { c, key } = shop();
    const t = terms2();
    expect(c.ftTransferCall(A, 25n, msg(key, t)).refunded).toBe(0n);
    expect(await c.creditOf(S)).toBe(25n);
    const [p] = await c.payments([t.paymentId, "ff".repeat(32)]);
    expect(p).toEqual({ id: t.paymentId, merchant: S, amount: 25n, payer: A, at: T0 });
    expect((await c.payments(["ff".repeat(32)]))[0]).toBeNull();
    c.solvency();
  });

  it("F3: the payment's storage is charged to the checkout settler, and without that balance the payment is refunded", async () => {
    const { c, key } = shop();
    const t = terms2();
    const before = await c.storageOf(NODE);
    expect(c.ftTransferCall(A, 25n, msg(key, t)).refunded).toBe(0n);
    expect(before - (await c.storageOf(NODE))).toBe(storageCost(storageBytes.payment(S, A) + storageBytes.credit(S, { settler: NODE })));
    // A second payment to the same merchant finds the credit entry there, so only the payment record is new.
    const mid = await c.storageOf(NODE);
    expect(c.ftTransferCall(B, 25n, msg(key, terms2())).refunded).toBe(0n);
    expect(mid - (await c.storageOf(NODE))).toBe(storageCost(storageBytes.payment(S, B)));

    await c.withdrawStorage(NODE, await c.storageOf(NODE));
    const unpaid = terms2();
    expect(c.ftTransferCall(A, 25n, msg(key, unpaid)).refunded).toBe(25n);
    expect((await c.payments([unpaid.paymentId]))[0]).toBeNull();
    expect(await c.creditOf(S)).toBe(50n);
    c.solvency();
  });

  it("the checkout settler must be on the allowlist", () => {
    const c = setup();
    expect(() => c.setCheckoutKey(kp(50).publicKey, "stranger.testnet")).toThrow(/NOT_SETTLER/);
  });

  it("refunds a wrong amount, expired terms, a repeat, a bad signature and an unknown tag", async () => {
    const { c, key } = shop();
    const t = terms2();
    expect(c.ftTransferCall(A, 24n, msg(key, t)).refunded).toBe(24n);
    c.ftTransferCall(A, 25n, msg(key, t));
    expect(c.ftTransferCall(A, 25n, msg(key, t)).refunded).toBe(25n);
    const old = terms2({ expiryMs: T0 - 1n });
    expect(c.ftTransferCall(A, 25n, msg(key, old)).refunded).toBe(25n);
    expect(c.ftTransferCall(A, 25n, msg(kp(51), terms2())).refunded).toBe(25n);
    expect(c.ftTransferCall(A, 7n, JSON.stringify({ nope: 1 })).refunded).toBe(7n);
    expect(c.ftTransferCall(A, 7n, "not json").refunded).toBe(7n);
    expect(await c.creditOf(S)).toBe(25n);
    c.solvency();
  });
});

describe("hub v2 pre-audit fixes", () => {
  const payMsg = (key: Keypair, amount: bigint, id = nextId()) => {
    const t = { paymentId: id, merchant: S, amount, expiryMs: T0 + 1000n };
    return JSON.stringify({
      payment: { payment_id: t.paymentId, merchant: t.merchant, amount: t.amount.toString(), expiry_ms: t.expiryMs.toString(), signature: signDigest(key.secretKey, checkoutDigest(HUB, NET, t)) },
    });
  };

  it("P2: the admin only proposes a checkout settler; the settler accepts the proposed key with one yoctoNEAR", async () => {
    const c = setup();
    const key = kp(50);
    c.addSettler("node2.testnet");
    c.setCheckoutKey(key.publicKey, "node2.testnet", { accept: false });
    expect(c.pendingCheckout()).toEqual({ key: key.publicKey, settler: "node2.testnet" });
    // Until the settler accepts, every payment is refunded and its storage balance is untouched.
    const balance = await c.storageOf("node2.testnet");
    expect(c.ftTransferCall(A, 20_000n, payMsg(key, 20_000n)).refunded).toBe(20_000n);
    expect(await c.storageOf("node2.testnet")).toBe(balance);
    expect(await code(c.acceptCheckout(NODE, key.publicKey))).toBe("NOT_PENDING_CHECKOUT");
    expect(await code(c.acceptCheckout("node2.testnet", key.publicKey, 0n))).toBe("ONE_YOCTO_REQUIRED");
    expect(await code(c.acceptCheckout("node2.testnet", kp(51).publicKey))).toBe("NOT_PENDING_CHECKOUT");
    await c.acceptCheckout("node2.testnet", key.publicKey);
    expect(c.pendingCheckout()).toBeNull();
    expect(c.ftTransferCall(A, 20_000n, payMsg(key, 20_000n)).refunded).toBe(0n);
    // A settler taken off the allowlist takes no more payments.
    c.removeSettler("node2.testnet");
    expect(c.ftTransferCall(A, 20_000n, payMsg(key, 20_000n)).refunded).toBe(20_000n);
    c.solvency();
  });

  it("P5: payments below the minimum are refunded; the default is 10 000 base units", () => {
    const c = setup();
    const key = kp(50);
    c.setCheckoutKey(key.publicKey);
    expect(c.minPayment).toBe(DEFAULT_MIN_PAYMENT);
    expect(DEFAULT_MIN_PAYMENT).toBe(10_000n);
    expect(c.ftTransferCall(A, 9_999n, payMsg(key, 9_999n)).refunded).toBe(9_999n);
    expect(c.ftTransferCall(A, 10_000n, payMsg(key, 10_000n)).refunded).toBe(0n);
    expect(() => c.setMinPayment(0n)).toThrow(/ZERO_AMOUNT/);
    c.solvency();
  });

  it("P8: the hub or the token as settler, and a validUntil not in milliseconds, are refused", () => {
    const c = setup();
    for (const settler of [HUB, c.token]) expect(() => c.openBudget(A, terms(A, agentA, { settler }))).toThrow(/INVALID_BUDGET/);
    expect(() => c.openBudget(A, terms(A, agentA, { validUntil: T0 * 1_000_000n }))).toThrow(/INVALID_BUDGET/);
    expect(() => c.openBudget(A, terms(A, agentA, { validUntil: MAX_VALID_UNTIL_MS + 1n }))).toThrow(/INVALID_BUDGET/);
    c.openBudget(A, terms(A, agentA, { validUntil: T0 + 100n * 365n * 86_400_000n }));
  });

  it("P4: settle_own counts payees too", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA, { maxPayees: 1 }));
    c.depositBudget(A, id, 100n);
    await settle(c, [claim(id, S, agentA, 1n, 1n)], { [id]: A });
    const v = claim(id, "other.testnet", agentA, 1n, 1n);
    expect(await code(c.settleOwn("other.testnet", v, accept(c, v), 10n ** 24n))).toBe("TOO_MANY_PAYEES");
    expect((await c.budget(id))!).toMatchObject({ maxPayees: 1, payeesPaid: 1 });
  });

  it("builds the checkout acceptance and the minimum with the hub's method names and deposits", () => {
    const key = kp(50);
    expect(acceptCheckoutTx(HUB, key.publicKey).actions[0]!.params).toMatchObject({ methodName: "accept_checkout", args: { key: toHex(publicKeyBytes(key.publicKey)) }, deposit: "1" });
    expect(setMinPaymentTx(HUB, 25_000n).actions[0]!.params).toMatchObject({ methodName: "set_min_payment", args: { amount: "25000" }, deposit: "1" });
  });
});

describe("solvency invariant", () => {
  it("holds across a random sequence of deposits, settlements, offsets, payouts and reclaims", async () => {
    // A small deterministic PRNG keeps failures reproducible.
    let s = 42;
    const rnd = (n: number) => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s % n;
    };
    const c = setup();
    const { a, b, owners } = pair(c, 500n, 500n);
    const cum: Record<string, bigint> = {};
    for (let i = 0; i < 300; i++) {
      const roll = rnd(5);
      if (roll === 0) c.depositBudget(B, b, BigInt(rnd(5) + 1));
      if (roll === 1) c.depositBudget(A, a, BigInt(rnd(5) + 1));
      if (roll === 2) await c.payout([A, B, S]);
      if (roll >= 3) {
        const claims: Claim[] = [];
        for (const [id, agent, payee] of [[a, agentA, rnd(2) ? B : S], [b, agentB, rnd(2) ? A : S]] as const) {
          if (rnd(3) === 0) continue;
          const key = `${id}:${payee}`;
          const amount = BigInt(rnd(4) + 1);
          cum[key] = (cum[key] ?? 0n) + amount;
          claims.push(claim(id, payee, agent, amount, cum[key]!));
        }
        if (claims.length) await settle(c, claims, owners).catch((e) => {
          // A rejected batch must leave the chain untouched, so the cumulative rolls back too.
          if (!(e instanceof ChainError)) throw e;
          for (const x of claims) cum[`${x.budgetId}:${x.payee}`] = x.cumulative - x.amount;
        });
      }
      c.solvency();
    }
    const stats = c.totals();
    expect(stats.tokenBalance).toBe(stats.escrow + stats.credits + stats.inFlight);
  });
});

describe("fund_from_credit", () => {
  /** A holds credit 30 from B's Budget, and its own Budget `a` has escrow 5. */
  async function ownerWithCredit() {
    const c = setup();
    const p = pair(c, 5n, 100n);
    await settle(c, [claim(p.b, A, agentB, 30n, 30n)], p.owners);
    expect(await c.creditOf(A)).toBe(30n);
    return { c, ...p };
  }

  it("moves credit into escrow only, never cap, and keeps escrow plus credits constant", async () => {
    const { c, a } = await ownerWithCredit();
    const before = c.totals();
    await c.fundFromCredit(A, a, 20n);
    expect(await c.budget(a)).toMatchObject({ escrow: 25n, cap: 1_000n, spent: 0n });
    expect(await c.creditOf(A)).toBe(10n);
    const after = c.totals();
    expect(after.escrow + after.credits).toBe(before.escrow + before.credits);
    expect(after.tokenBalance).toBe(before.tokenBalance);
    c.solvency();
  });

  it("lets a batch settle that the escrow alone could not cover", async () => {
    const { c, a } = await ownerWithCredit();
    expect(await code(settle(c, [claim(a, S, agentA, 30n, 30n)], { [a]: A }))).toBe("INSUFFICIENT_ESCROW");
    await c.fundFromCredit(A, a, 25n);
    await settle(c, [claim(a, S, agentA, 30n, 30n)], { [a]: A });
    expect((await c.budget(a))!.escrow).toBe(0n);
    c.solvency();
  });

  it("refuses zero, more than the credit, a non-owner, an unknown Budget and a wrong deposit", async () => {
    const { c, a, b } = await ownerWithCredit();
    expect(await code(c.fundFromCredit(A, a, 0n))).toBe("ZERO_AMOUNT");
    expect(await code(c.fundFromCredit(A, a, 31n))).toBe("INSUFFICIENT_CREDIT");
    expect(await code(c.fundFromCredit(B, a, 1n))).toBe("NOT_OWNER");
    expect(await code(c.fundFromCredit(A, b, 1n))).toBe("NOT_OWNER");
    expect(await code(c.fundFromCredit(A, "77".repeat(32), 1n))).toBe("UNKNOWN_BUDGET");
    expect(await code(c.fundFromCredit(B, b, 1n))).toBe("INSUFFICIENT_CREDIT");
    await expect(c.fundFromCredit(A, a, 1n, 0n)).rejects.toMatchObject({ code: "ONE_YOCTO_REQUIRED" });
    expect(await c.creditOf(A)).toBe(30n);
    expect((await c.budget(a))!.escrow).toBe(5n);
  });

  it("refuses a revoked or expired Budget", async () => {
    const r = await ownerWithCredit();
    await r.c.revokeBudget(A, r.a);
    expect(await code(r.c.fundFromCredit(A, r.a, 1n))).toBe("BUDGET_NOT_OPEN");

    const e = await ownerWithCredit();
    e.c.advance(86_400_000n);
    await e.c.fundFromCredit(A, e.a, 1n);
    e.c.advance(1n);
    expect(await code(e.c.fundFromCredit(A, e.a, 1n))).toBe("BUDGET_NOT_OPEN");
    e.c.solvency();
  });

  it("builds the owner's wallet transaction with the hub's method name, argument shape and one yoctoNEAR", () => {
    const tx = fundFromCreditTx(HUB, "ab".repeat(32), 1_234n);
    expect(tx.receiverId).toBe(HUB);
    expect(tx.actions).toEqual([
      { type: "FunctionCall", params: { methodName: "fund_from_credit", args: { budget_id: "ab".repeat(32), amount: "1234" }, gas: "30000000000000", deposit: "1" } },
    ]);
  });
});

describe("hub v2 rules", () => {
  const weakKey = publicKeyToString(new Uint8Array(32));
  const nonCanonical = publicKeyToString(Uint8Array.from([0xee, ...new Array<number>(30).fill(0xff), 0x7f]));

  it("lists every new refusal code", () => {
    for (const c of ["AMOUNT_ABOVE_STEP", "DEPOSIT_REQUIRED", "ENCODING_FAILED", "INSUFFICIENT_RESERVE", "INVALID_KEY", "NOT_PENDING_ADMIN", "NOT_SELF", "ONE_YOCTO_REQUIRED"]) {
      expect(HUB_ERRORS).toContain(c);
    }
  });

  it("F3: refuses a small-order or non-canonical agent, receipt or checkout key", async () => {
    const c = setup();
    expect(() => c.openBudget(A, { ...terms(A, agentA), agentPk: weakKey })).toThrow(/INVALID_BUDGET/);
    expect(() => c.openBudget(A, { ...terms(A, agentA), agentPk: nonCanonical })).toThrow(/INVALID_BUDGET/);
    expect(await code(c.registerReceiptKey(NODE, weakKey))).toBe("INVALID_KEY");
    expect(await code(c.registerReceiptKey(NODE, nonCanonical))).toBe("INVALID_KEY");
    expect(() => c.setCheckoutKey(weakKey)).toThrow(/INVALID_KEY/);
  });

  it("item 12: a Budget lists 1 to 16 payees or may pay any, up to the payees it declares", () => {
    const c = setup();
    expect(() => c.openBudget(A, terms(A, agentA, { maxPayees: 0 }))).toThrow(/INVALID_BUDGET/);
    expect(() => c.openBudget(A, terms(A, agentA, { maxPayees: MAX_ANY_PAYEES + 1 }))).toThrow(/INVALID_BUDGET/);
    expect(() => c.openBudget(A, terms(A, agentA, { payees: Array.from({ length: 17 }, (_, i) => `p${i}.testnet`) }))).toThrow(/INVALID_BUDGET/);
    const any = c.openBudget(A, terms(A, agentA, { maxPayees: MAX_ANY_PAYEES }));
    expect(c.storageReserve(any)).toBe(MAX_ANY_PAYEES * PAIR_BYTES);
    const listed = c.openBudget(B, terms(B, agentB, { payees: [S, C, S] }));
    expect(c.storageReserve(listed)).toBe(2 * PAIR_BYTES);
    // What the wallet sends: the explicit flag, with the declared slots only for a Budget with no list.
    expect(budgetTermsArgs(terms(A, agentA))).toMatchObject({ payees: [], allow_any_payee: true, max_payees: 16 });
    expect(budgetTermsArgs(terms(A, agentA, { maxPayees: 40 }))).toMatchObject({ allow_any_payee: true, max_payees: 40 });
    expect(budgetTermsArgs(terms(A, agentA, { payees: [S], maxPayees: 40 }))).toMatchObject({ payees: [S], allow_any_payee: false, max_payees: 0 });
  });

  it("F5: a revoke after valid_until is refused, so the expiry grace stands", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    c.advance(86_400_000n + 1n);
    expect(await code(c.revokeBudget(A, id))).toBe("BUDGET_NOT_OPEN");
    c.advance(EXPIRY_GRACE_MS - 1n);
    await settle(c, [claim(id, S, agentA, 10n, 10n)], { [id]: A });
    expect(await c.creditOf(S)).toBe(10n);
  });

  it("F6: two settlers can use the same batch id, and neither can take the other's", async () => {
    const c = setup();
    const other = "other-node.testnet";
    c.addSettler(other);
    const a = c.openBudget(A, terms(A, agentA));
    const b = c.openBudget(B, terms(B, agentB, { settler: other }));
    c.depositBudget(A, a, 100n);
    c.depositBudget(B, b, 100n);
    const batchId = nextId();
    const vb = claim(b, S, agentB, 1n, 1n);
    await c.settleAs(other, { batchId, root: "66".repeat(32), claims: [vb], expectedNet: computeNetting([{ owner: B, payee: S, delta: 1n }]).entries });
    await settle(c, [claim(a, S, agentA, 10n, 10n)], { [a]: A }, batchId);
    expect(await c.batch(batchId, other)).toMatchObject({ root: "66".repeat(32), gross: 1n });
    expect(await c.batch(batchId, NODE)).toMatchObject({ root: ROOT, gross: 10n });
    expect(await code(settle(c, [claim(a, S, agentA, 1n, 11n)], { [a]: A }, batchId))).toBe("BATCH_EXISTS");
  });

  it("F7: a voucher's amount can be below the cumulative step, never above it", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 500n);
    const over = claim(id, S, agentA, 401n, 400n);
    expect(await code(settle(c, [over], { [id]: A }))).toBe("AMOUNT_ABOVE_STEP");
    expect(await code(c.settleOwn(S, over, accept(c, over)))).toBe("AMOUNT_ABOVE_STEP");
    await settle(c, [claim(id, S, agentA, 1n, 400n)], { [id]: A });
    expect(await c.creditOf(S)).toBe(400n);
  });

  it("prune refunds freed entries and the unused reserve after the deadline, and only to the owner", async () => {
    const c = setup();
    const id = c.openBudget(A, terms(A, agentA));
    c.depositBudget(A, id, 100n);
    await settle(c, [claim(id, S, agentA, 5n, 5n)], { [id]: A });
    expect(await code(c.prune(B, id, [S]))).toBe("NOT_OWNER");
    expect(await code(c.prune(A, id, Array.from({ length: MAX_PRUNE_PAYEES + 1 }, (_, i) => `p${i}.testnet`)))).toBe("TOO_MANY_ACCOUNTS");
    expect(await code(c.prune(A, id, [S]))).toBe("TOO_EARLY");
    c.advance(86_400_000n + EXPIRY_GRACE_MS + 1n);
    const reserve = c.storageReserve(id);
    const { refundedYocto } = await c.prune(A, id, [S, "never-paid.testnet"]);
    expect(refundedYocto).toBe(storageCost(reserve + storageBytes.settled(S)));
    expect(await c.settledOf(id, S)).toBe(0n);
    expect(c.storageReserve(id)).toBe(0);
    expect(await c.budget(id)).not.toBeNull();
    // S's credit entry was the Budget's: paid out, its bytes come back, and a second prune refunds them.
    await c.payout([S]);
    expect((await c.prune(A, id, [])).refundedYocto).toBe(storageCost(storageBytes.credit(S, { budget: id })));
  });

  it("builds prune and the two-step admin transfer with the hub's method names and deposits", () => {
    expect(pruneTx(HUB, "ab".repeat(32), [S]).actions[0]!.params).toMatchObject({ methodName: "prune", args: { budget_id: "ab".repeat(32), payees: [S] }, deposit: "0" });
    expect(proposeAdminTx(HUB, "next.testnet").actions[0]!.params).toMatchObject({ methodName: "propose_admin", args: { new_admin: "next.testnet" } });
    expect(proposeAdminTx(HUB, null).actions[0]!.params.args).toEqual({ new_admin: null });
    expect(acceptAdminTx(HUB).actions[0]!.params).toMatchObject({ methodName: "accept_admin", args: {}, deposit: "1" });
  });
});
