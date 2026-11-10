/**
 * A payee settling its own voucher on the hub (`settle_own`, spec decision 4) must not desync the node: the node reads
 * the hub's settled position, books what the seller settled itself (outside any batch, so without a Merkle proof),
 * and rebuilds a batch that a `settle_own` raced. A batch id the hub holds for another settler or root is never booked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeChain } from "@payminto/chain/fake";
import { ChainError, SCHEME, X402_VERSION, acceptanceDigest, sha256Text, type Acceptance, type AccountId, type Batch, type Chain, type Claim, type Id32, type SettleArgs, type TxHash } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { OWNER_A, OWNER_B, SELLER, openBudget, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const PRICE = 1_000n;
const OTHER = "other.seller.testnet";

/** FakeChain behind a seam the test can interrupt just before a batch reaches the hub, or answer for. */
function seam(fake: FakeChain) {
  const control = {
    /** Runs once, after the node's pre-checks and before the hub sees the next batch. */
    beforeSettle: null as null | (() => Promise<void>),
    /** Replaces the hub's answer to the next `settle`. */
    settleOnce: null as null | ((args: SettleArgs) => Promise<TxHash>),
    /** What `batch(id)` answers instead of the hub, when set. */
    batchAnswer: null as null | ((id: Id32) => Batch | null),
    settles: [] as SettleArgs[],
  };
  const chain = new Proxy(fake, {
    get(target, prop) {
      if (prop === "settle") {
        return async (args: SettleArgs) => {
          control.settles.push(args);
          const before = control.beforeSettle;
          control.beforeSettle = null;
          await before?.();
          const once = control.settleOnce;
          control.settleOnce = null;
          return once ? once(args) : target.settle(args);
        };
      }
      if (prop === "batch") return async (id: Id32, settler: AccountId) => (control.batchAnswer ? control.batchAnswer(id) : target.batch(id, settler));
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as Chain;
  return { chain, control };
}

const tmp = tempDir("payminto-seller-settle-");
let fake: FakeChain;
let control: ReturnType<typeof seam>["control"];
let node: ClearingNode;

const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${node.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

const providers = new Map<AccountId, { id: string; apiKey: string }>();
async function providerFor(payee: AccountId) {
  let p = providers.get(payee);
  if (!p) {
    const r = await admin("POST", "/v1/providers", { name: payee, payee, priceAtomic: PRICE.toString(), resource: `https://${payee}/api` });
    expect(r.status).toBe(201);
    p = r.json as { id: string; apiKey: string };
    providers.set(payee, p);
  }
  return p;
}

/**
 * Every voucher the node accepted, per (Budget, payee), oldest first, each with the node's acceptance from its
 * receipt: what a seller holds for `settle_own`, which takes a voucher only with that acceptance.
 */
type Held = { claim: Claim; acceptance: Acceptance };
const held = new Map<string, Held[]>();
const vouchersOf = (b: OpenedBudget, payee: AccountId) => held.get(`${b.id}:${payee}`) ?? [];
const settleOwn = (payee: AccountId, h: Held) => fake.settleOwn(payee, h.claim, h.acceptance);

async function pay(b: OpenedBudget, payee: AccountId) {
  const p = await providerFor(payee);
  const position = (await admin("GET", `/v1/budgets/${b.id}/position?payee=${payee}`)).json;
  const next = BigInt(position.cumulative) + PRICE;
  const requestHash = sha256Text(`req-${Math.random()}`);
  const v = { budgetId: b.id, payee, amount: PRICE, cumulative: next, requestHash };
  const signature = signVoucher(fake, b.agent, v);
  const r = await fetch(`${node.url}/v1/vouchers`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, scheme: SCHEME, network: fake.network, providerId: p.id, requestHash, payload: { budgetId: b.id, payee, amount: PRICE.toString(), cumulative: next.toString(), signature, requestHash } }),
  });
  const json = (await r.json()) as any;
  expect(r.status, JSON.stringify(json)).toBe(200);
  const acceptance: Acceptance = { nodeKey: json.receipt.node, timestampS: BigInt(json.receipt.timestamp), signature: json.receipt.nodeSignature };
  held.set(`${b.id}:${payee}`, [...vouchersOf(b, payee), { claim: { ...v, signature }, acceptance }]);
  return json.receipt.callId as Id32;
}

const settle = async () => (await admin("POST", "/v1/settlements")).json;
const callsOf = async (b: OpenedBudget, payee: AccountId) =>
  ((await admin("GET", `/v1/calls?budgetId=${b.id}&payee=${payee}&limit=500`)).json.items as Array<{ id: string; status: string; settledBy: string | null; batchId: string | null; cumulative: string }>).reverse();
const pending = async (b: OpenedBudget) => (await admin("GET", `/v1/budgets/${b.id}`)).json.spend.pending as string;
const balanceOf = async (account: string) => {
  const tb = (await admin("GET", "/v1/ledger/trial-balance")).json;
  expect(tb.balanced).toBe(true);
  return (tb.accounts.find((a: { account: string }) => a.account === account)?.balance ?? "0") as string;
};
const alerts = () =>
  node.services.db.all<{ payload: string }>("SELECT payload FROM events WHERE type = 'operator.alert' ORDER BY id").map((r) => (JSON.parse(r.payload) as { alert: { kind: string } }).alert);

let seed = 10;
const budget = (owner: AccountId, escrow = 1_000_000n) => openBudget(fake, node.url, ADMIN, owner, testKey(seed++), { escrow });

beforeAll(async () => {
  fake = startFakeChain([OWNER_A, OWNER_B, SELLER, OTHER]);
  const s = seam(fake);
  control = s.control;
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN }), { chain: s.chain, logger: silentLogger, port: 0, workers: false });
  // The node's account registers the key it signs acceptances with, as the hub requires for settle_own.
  await fake.registerReceiptKey(fake.operator, node.services.chain.nodeKey);
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("a seller settles its own voucher on the hub", () => {
  let b: OpenedBudget;
  let callIds: Id32[];

  it("books the calls as settled by the seller, outside any batch, instead of dropping the pair for good", async () => {
    b = await budget(OWNER_A);
    callIds = [await pay(b, SELLER), await pay(b, SELLER), await pay(b, SELLER)];
    expect(await pending(b)).toBe("3000");
    // The seller does not wait for the node: it settles its latest voucher itself.
    await settleOwn(SELLER, vouchersOf(b, SELLER).at(-1)!);
    expect(await fake.settledOf(b.id, SELLER)).toBe(3_000n);

    const out = await settle();
    expect(out.batchIds ?? []).toEqual([]);
    expect(out.sellerSettled).toEqual([{ id: expect.stringMatching(/^sst_/), budgetId: b.id, payee: SELLER, previous: "0", cumulative: "3000", amount: "3000", uncleared: "0", calls: 3 }]);
    expect(out.dropped ?? []).toEqual([]);

    // Truthful call status: settled, by the seller, in no batch.
    expect((await callsOf(b, SELLER)).map((c) => [c.status, c.settledBy, c.batchId])).toEqual(Array(3).fill(["settled", "seller", null]));
    // The Budget's exposure is no longer inflated, so NET_EXPOSURE does not creep up on it.
    expect(await pending(b)).toBe("0");
    expect((await admin("GET", `/v1/budgets/${b.id}/position?payee=${SELLER}`)).json).toMatchObject({ cumulative: "3000", settled: "3000" });
    // The ledger moved what the hub moved: the payable is cleared, escrow went down, the seller's hub credit went up.
    expect(await balanceOf(`owner:${OWNER_A}:payable`)).toBe("0");
    expect(await balanceOf(`provider:${SELLER}:receivable`)).toBe("0");
    expect(await balanceOf(`owner:${OWNER_A}:escrow`)).toBe("-3000");
    expect(await balanceOf(`provider:${SELLER}:credit`)).toBe("3000");
    const journal = (await admin("GET", `/v1/ledger?account=owner:${OWNER_A}:escrow`)).json;
    expect(journal[0]).toMatchObject({ kind: "seller.settled", ref: out.sellerSettled[0].id, credit: "3000" });
  });

  it("says in the proof that the call has no Merkle proof, and checks the hub's settled position instead", async () => {
    const proof = (await admin("GET", `/v1/receipts/${callIds[1]}/proof`)).json;
    expect(proof).toMatchObject({
      status: "settled",
      settledBy: "seller",
      batchId: null,
      batchStatus: null,
      receiptsRoot: null,
      leaf: null,
      proof: [],
      txHash: null,
      onchainVerified: null,
      sellerSettlement: { id: expect.stringMatching(/^sst_/), previous: "0", cumulative: "3000", hubSettled: "3000", covered: true },
    });
    // The node's acceptance receipt is still there and still signed.
    expect(proof.receipt).toMatchObject({ callId: callIds[1], cumulative: "2000", node: node.services.chain.nodeKey });
  });

  it("keeps the pair in later batches", async () => {
    await pay(b, SELLER);
    const out = await settle();
    expect(out.batchIds).toHaveLength(1);
    expect(out.sellerSettled).toEqual([]);
    expect(await fake.settledOf(b.id, SELLER)).toBe(4_000n);
    const batch = (await admin("GET", `/v1/batches/${out.batchIds[0]}`)).json;
    expect(batch.claimList).toEqual([expect.objectContaining({ budgetId: b.id, payee: SELLER, previous: "3000", cumulative: "4000", delta: "1000", calls: 1 })]);
    const calls = await callsOf(b, SELLER);
    expect(calls.map((c) => c.settledBy)).toEqual(["seller", "seller", "seller", "batch"]);
    expect((await admin("GET", `/v1/receipts/${calls[3]!.id}/proof`)).json).toMatchObject({ settledBy: "batch", onchainVerified: true });
    fake.solvency();
  });

  it("books an older voucher the seller settled, and batches the rest of the pair", async () => {
    const c = await budget(OWNER_A);
    for (let i = 0; i < 3; i++) await pay(c, SELLER);
    // The seller's copy is one call behind: it settles 2,000 of the 3,000 the node accepted.
    await settleOwn(SELLER, vouchersOf(c, SELLER)[1]!);
    const out = await settle();
    expect(out.sellerSettled).toEqual([expect.objectContaining({ budgetId: c.id, payee: SELLER, previous: "0", cumulative: "2000", amount: "2000", calls: 2 })]);
    expect(out.batchIds).toHaveLength(1);
    expect((await callsOf(c, SELLER)).map((x) => x.settledBy)).toEqual(["seller", "seller", "batch"]);
    expect(await fake.settledOf(c.id, SELLER)).toBe(3_000n);
    expect(await pending(c)).toBe("0");
    fake.solvency();
  });

  it("finds a seller settlement between settlements too, without building a batch", async () => {
    const c = await budget(OWNER_B);
    await pay(c, SELLER);
    await settleOwn(SELLER, vouchersOf(c, SELLER).at(-1)!);
    expect(await pending(c)).toBe("1000");
    const booked = await node.services.settlement.syncSettled();
    expect(booked).toEqual([expect.objectContaining({ budgetId: c.id, payee: SELLER, amount: "1000", calls: 1 })]);
    expect(await pending(c)).toBe("0");
    expect(await node.services.settlement.syncSettled()).toEqual([]);
  });
});

describe("a settle_own that lands between the node's pre-checks and its batch", () => {
  it("rebuilds the batch without the claim the hub calls stale, and retries", async () => {
    const b = await budget(OWNER_A);
    const sellerCalls = [await pay(b, SELLER), await pay(b, SELLER)];
    const otherCall = await pay(b, OTHER);
    const before = control.settles.length;
    // The node has read the hub and built its batch; the seller's settle_own lands first.
    control.beforeSettle = async () => void (await settleOwn(SELLER, vouchersOf(b, SELLER).at(-1)!));
    const out = await settle();
    // First send: both claims, refused whole with STALE_VOUCHER. Second send: only the claim that is still owed.
    const sent = control.settles.slice(before);
    expect(sent.map((s) => s.claims.map((c) => c.payee).sort())).toEqual([[OTHER, SELLER].sort(), [OTHER]]);
    expect(out.batchIds).toHaveLength(1);
    expect(out.sellerSettled).toEqual([expect.objectContaining({ budgetId: b.id, payee: SELLER, amount: "2000", calls: 2 })]);
    expect(await fake.settledOf(b.id, OTHER)).toBe(PRICE);
    expect(await pending(b)).toBe("0");

    const batches = (await admin("GET", "/v1/batches?limit=2")).json;
    expect(batches[0]).toMatchObject({ id: out.batchIds[0], status: "confirmed", claims: 1 });
    expect(batches[1]).toMatchObject({ status: "failed", error: expect.stringMatching(/STALE_VOUCHER/) });
    const settledBy = async (id: Id32) => (await admin("GET", `/v1/receipts/${id}/proof`)).json.settledBy;
    expect(await Promise.all([...sellerCalls, otherCall].map(settledBy))).toEqual(["seller", "seller", "batch"]);
    fake.solvency();
  });

  it("rebuilds a batch the hub refuses with NET_MISMATCH because the seller settled part of a claim", async () => {
    const b = await budget(OWNER_B);
    await pay(b, SELLER);
    await pay(b, SELLER);
    await pay(b, OTHER);
    const before = control.settles.length;
    // The seller settles its older voucher: the node's claim is still valid but worth less, so its net is wrong.
    control.beforeSettle = async () => void (await settleOwn(SELLER, vouchersOf(b, SELLER)[0]!));
    const out = await settle();
    const sent = control.settles.slice(before);
    expect(sent).toHaveLength(2);
    expect(out.batchIds).toHaveLength(1);
    expect(out.sellerSettled).toEqual([expect.objectContaining({ payee: SELLER, amount: "1000", calls: 1 })]);
    expect((await admin("GET", `/v1/batches/${out.batchIds[0]}`)).json.claimList.map((c: { payee: string; delta: string }) => [c.payee, c.delta]).sort()).toEqual(
      [
        [OTHER, "1000"],
        [SELLER, "1000"],
      ].sort(),
    );
    expect(await fake.settledOf(b.id, SELLER)).toBe(2_000n);
    expect(await pending(b)).toBe("0");
    fake.solvency();
  });

  it("does not retry forever a batch the hub refuses for another reason", async () => {
    const b = await budget(OWNER_A);
    await pay(b, OTHER);
    const before = control.settles.length;
    control.settleOnce = async () => {
      throw new ChainError("NET_MISMATCH", "refused for the test");
    };
    const out = await settle();
    expect(control.settles.length - before).toBe(1);
    expect(out.skipped).toBeDefined();
    expect((await admin("GET", "/v1/batches?limit=1")).json[0]).toMatchObject({ status: "failed" });
    // Nothing was wrong on the hub: the next run settles the call.
    expect((await settle()).batchIds).toHaveLength(1);
  });
});

describe("a seller settles a voucher the node never accepted", () => {
  it("follows the hub's position, books the uncleared amount apart, and pages the operator", async () => {
    const b = await budget(OWNER_B);
    await pay(b, SELLER);
    // The agent signed 5,000 to the seller; this node's database only ever accepted 1,000 of it. The hub takes the
    // voucher through settle_own only with an acceptance by the node's registered key, so this can happen only when
    // that key signed outside this database: a leaked key, or a database restored from before the call.
    const v = { budgetId: b.id, payee: SELLER, amount: 4_000n, cumulative: 5_000n, requestHash: sha256Text("never accepted") };
    const unknown: Claim = { ...v, signature: signVoucher(fake, b.agent, v) };
    const at = BigInt(Math.floor(Date.now() / 1000));
    await fake.settleOwn(SELLER, unknown, { nodeKey: node.services.chain.nodeKey, timestampS: at, signature: node.services.chain.signAcceptance(acceptanceDigest(unknown, at)) });
    const creditBefore = await balanceOf(`provider:${SELLER}:credit`);
    const seen = alerts().length;

    const out = await settle();
    expect(out.sellerSettled).toEqual([expect.objectContaining({ budgetId: b.id, payee: SELLER, previous: "0", cumulative: "5000", amount: "5000", uncleared: "4000", calls: 1 })]);
    // The node's position follows the hub, so the next voucher extends what the hub has settled and the cap still holds.
    expect((await admin("GET", `/v1/budgets/${b.id}/position?payee=${SELLER}`)).json).toMatchObject({ cumulative: "5000", settled: "5000" });
    expect(await pending(b)).toBe("0");
    expect((await admin("GET", `/v1/budgets/${b.id}`)).json.spend).toMatchObject({ total: "5000", settled: "5000" });
    expect(BigInt(await balanceOf(`provider:${SELLER}:credit`)) - BigInt(creditBefore)).toBe(5_000n);
    expect(alerts().slice(seen)).toEqual([expect.objectContaining({ kind: "seller_settled_uncleared", budgetId: b.id, payee: SELLER, uncleared: "4000" })]);

    await pay(b, SELLER);
    expect((await settle()).batchIds).toHaveLength(1);
    expect(await fake.settledOf(b.id, SELLER)).toBe(6_000n);
    fake.solvency();
  });
});

describe("a batch of this node whose send got no verdict", () => {
  /** Sends the next batch into the void: the node hears nothing, and the test keeps what was sent. */
  const loseNextSend = () => {
    const lost: SettleArgs[] = [];
    control.settleOnce = async (args) => {
      lost.push(args);
      throw new Error("request timed out");
    };
    return lost;
  };

  it("is never mistaken for a seller settlement when it lands and the hub cannot be asked about it", async () => {
    const b = await budget(OWNER_A);
    const callId = await pay(b, OTHER);
    const lost = loseNextSend();
    expect((await settle()).skipped).toBeDefined();
    // The lost send reaches the hub after all, and for a while the node cannot read batches.
    await fake.settle(lost[0]!);
    control.batchAnswer = () => {
      throw new Error("fetch failed");
    };
    const blind = await settle();
    expect(blind.sellerSettled ?? []).toEqual([]);
    expect(blind.dropped).toEqual([expect.objectContaining({ budgetId: b.id, payee: OTHER, reason: expect.stringMatching(/could not be read/) })]);
    expect((await admin("GET", `/v1/receipts/${callId}/proof`)).json).toMatchObject({ status: "accepted", settledBy: null });
    // Readable again: the batch is adopted, and the call is settled by this node's batch with its Merkle proof.
    control.batchAnswer = null;
    await settle();
    expect((await admin("GET", `/v1/receipts/${callId}/proof`)).json).toMatchObject({ status: "settled", settledBy: "batch", batchId: lost[0]!.batchId, onchainVerified: true });
    fake.solvency();
  });

  it("does not hide a seller settlement of the same pair, and can no longer land after it", async () => {
    const b = await budget(OWNER_B);
    const callId = await pay(b, OTHER);
    const lost = loseNextSend();
    expect((await settle()).skipped).toBeDefined();
    await settleOwn(OTHER, vouchersOf(b, OTHER).at(-1)!);
    // The hub has no batch under the lost id, so the position moved outside this node: a seller settlement.
    const out = await settle();
    expect(out.sellerSettled).toEqual([expect.objectContaining({ budgetId: b.id, payee: OTHER, amount: "1000", calls: 1 })]);
    expect((await admin("GET", `/v1/receipts/${callId}/proof`)).json).toMatchObject({ status: "settled", settledBy: "seller", batchId: null });
    await expect(fake.settle(lost[0]!)).rejects.toThrow(/STALE_VOUCHER/);
    fake.solvency();
  });
});

describe("the books", () => {
  it("carry seller settlements next to the batches, gross equal to net, in the export and the overview", async () => {
    const all = (await admin("GET", "/v1/settlements/export")).json;
    // Seven so far: 3,000, 2,000 and 1,000 in the first group, 2,000 and 1,000 raced, 5,000 with 4,000 uncleared, and
    // the 1,000 the other seller settled under a lost batch.
    expect(all.sellerSettlements.map((s: { amount: string }) => s.amount)).toEqual(["3000", "2000", "1000", "2000", "1000", "5000", "1000"]);
    expect(all.totals.sellerSettlements).toBe(7);
    expect(all.sellerSettlements[5]).toMatchObject({ owner: OWNER_B, payee: SELLER, amount: "5000", uncleared: "4000", calls: 1, id: expect.stringMatching(/^sst_/) });
    for (const p of all.parties) expect(BigInt(p.grossOut) - BigInt(p.grossIn)).toBe(BigInt(p.netDebit) - BigInt(p.netCredit));
    // The seller's revenue is everything the hub credited it: its own settlements and this node's batches.
    const seller = all.parties.find((p: { account: string }) => p.account === SELLER);
    expect(seller.grossIn).toBe((await fake.creditOf(SELLER)).toString());
    expect(seller.netCredit).toBe(seller.grossIn);

    const overview = (await admin("GET", "/v1/overview")).json;
    expect(overview.settledBySeller).toEqual({ gross: "15000", calls: 11, settlements: 7 });

    const csv = await (await fetch(`${node.url}/v1/settlements/export?account=${SELLER}&format=csv`, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
    const own = csv.split("\r\n").filter((l) => l.includes("sst_"));
    // One gross and one net line per settlement for the one party asked for.
    expect(own).toHaveLength(12);
    expect(own.every((l) => l.includes(SELLER))).toBe(true);
  });
});

describe("a batch id the hub holds for someone else", () => {
  const foreign = (root: string, settler: AccountId): Batch => ({ root, settler, gross: 1n, net: 1n, at: 0n });

  it("is a hard error on BATCH_EXISTS: never booked, calls back in the queue, operator paged", async () => {
    const b = await budget(OWNER_A);
    const callId = await pay(b, OTHER);
    for (const [answer, why] of [
      [(root: string) => foreign(root, "evil.settler.testnet"), /settled by evil\.settler\.testnet/],
      [() => foreign("ee".repeat(32), fake.operator), /another receipts root/],
    ] as const) {
      const seen = alerts().length;
      let sent: SettleArgs | null = null;
      control.settleOnce = async (args) => {
        sent = args;
        throw new ChainError("BATCH_EXISTS", args.batchId);
      };
      // Only the id under test is answered for; every other batch is unknown to this stand-in hub.
      control.batchAnswer = (id) => (sent && id === sent.batchId ? answer(sent.root) : null);
      const out = await settle();
      control.batchAnswer = null;
      expect(out.batchIds ?? []).toEqual([]);
      const failed = (await admin("GET", "/v1/batches?limit=1")).json[0];
      expect(failed).toMatchObject({ status: "failed", error: expect.stringMatching(why) });
      expect((await admin("GET", `/v1/receipts/${callId}/proof`)).json).toMatchObject({ status: "accepted", batchId: null });
      expect(alerts().slice(seen)).toEqual([expect.objectContaining({ kind: "batch_mismatch", batchId: failed.id })]);
    }
    // The hub never had this node's batch: the call settles in a new one.
    expect((await settle()).batchIds).toHaveLength(1);
    expect(await fake.settledOf(b.id, OTHER)).toBe(PRICE);
  });

  it("is a hard error when a send without a verdict finds a foreign batch under its id", async () => {
    const b = await budget(OWNER_B);
    const callId = await pay(b, OTHER);
    const seen = alerts().length;
    let sentId = "";
    control.settleOnce = async (args) => {
      sentId = args.batchId;
      throw new Error("request timed out");
    };
    control.batchAnswer = (id) => (id === sentId ? foreign("ee".repeat(32), "evil.settler.testnet") : null);
    const out = await settle();
    expect(out.batchIds ?? []).toEqual([]);
    expect((await admin("GET", "/v1/batches?limit=1")).json[0]).toMatchObject({ status: "failed" });
    expect((await admin("GET", `/v1/receipts/${callId}/proof`)).json.status).toBe("accepted");
    expect(alerts().slice(seen).map((a) => a.kind)).toEqual(["batch_mismatch"]);
    control.batchAnswer = null;
    expect((await settle()).batchIds).toHaveLength(1);
  });
});
