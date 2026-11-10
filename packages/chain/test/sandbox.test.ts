/**
 * End to end against a real near-sandbox node: the deploy script deploys and locks the hub, owners act only through the
 * pure wallet action builders, and the node acts only through NearRpcChain with a function-call key.
 *
 * Slow (about a minute), so it is skipped unless PAYMINTO_SANDBOX=1. Run it with:
 *   pnpm --filter @payminto/chain test:sandbox
 * The sandbox binary comes from NEAR_SANDBOX_BIN_PATH, else the copy the contract's cargo tests downloaded, else
 * near-kit downloads near-sandbox 2.14.0.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKey, Near, type KeyPair } from "near-kit";
import { Sandbox } from "near-kit/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployHub, type DeployReport } from "../scripts/deploy-hub.ts";
import {
  budgetIdOf,
  buildReceiptTree,
  ChainError,
  computeNetting,
  depositBudgetTx,
  fundFromCreditTx,
  fundStorageTx,
  keypairFromSeed,
  maxSettleBatchStorageCost,
  openBudgetTx,
  revokeBudgetTx,
  settleOwnTx,
  signAcceptance,
  signDigest,
  storageBytes,
  storageCost,
  voucherDigest,
  withdrawStorageTx,
  type BudgetTerms,
  type Claim,
  type Keypair,
  type ReceiptFields,
} from "../src/index.ts";
import { NearRpcChain, NearRpcError, payoutGasNeededTgas, payoutGasTgas, sendWalletTx } from "../src/node.ts";

const RUN = process.env["PAYMINTO_SANDBOX"] === "1";
const NETWORK = "near:sandbox" as const;
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ONE_NEAR = 10n ** 24n;
const DAY_MS = 86_400_000n;
/** The node's signing key: it signs checkout terms and the acceptance of every call, so the hub holds it as both. */
const CHECKOUT = keypairFromSeed(new Uint8Array(32).fill(50));

function sandboxBinary(): string | undefined {
  const fromEnv = process.env["NEAR_SANDBOX_BIN_PATH"];
  if (fromEnv) return fromEnv;
  const build = join(ROOT_DIR, "contracts-near", "target", "debug", "build");
  if (!existsSync(build)) return undefined;
  for (const dir of readdirSync(build).filter((d) => d.startsWith("near-sandbox-"))) {
    const bin = join(build, dir, "out", ".near", "near-sandbox-2.14.0", "near-sandbox");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

type Actor = { id: string; key: KeyPair; near: Near };

describe.skipIf(!RUN)("hub on near-sandbox through NearRpcChain", () => {
  let sandbox: Sandbox;
  let root: Near;
  let hub: Actor, admin: Actor, token: Actor, node: Actor, alice: Actor, bob: Actor, seller: Actor;
  let report: DeployReport;
  let chain: NearRpcChain;
  let reader: NearRpcChain;
  const agentA = keypairFromSeed(new Uint8Array(32).fill(1));
  const agentB = keypairFromSeed(new Uint8Array(32).fill(2));

  const actor = async (name: string, balance: string): Promise<Actor> => {
    const id = `${name}.${sandbox.rootAccount.id}`;
    const key = generateKey();
    await root
      .transaction(sandbox.rootAccount.id)
      .createAccount(id)
      .transfer(id, balance as `${number} NEAR`)
      .addKey(key.publicKey.toString(), { type: "fullAccess" })
      .send({ waitUntil: "FINAL" });
    const near = new Near({ network: { rpcUrl: sandbox.rpcUrl, networkId: "localnet" }, keyStore: { [id]: key.secretKey } });
    return { id, key, near };
  };

  const terms = (owner: string, agent: Keypair, salt: string, over: Partial<BudgetTerms> = {}): BudgetTerms => ({
    owner,
    agentPk: agent.publicKey,
    settler: node.id,
    cap: 1_000n,
    validUntil: BigInt(Date.now()) + DAY_MS,
    payees: [],
    policyHash: "aa".repeat(32),
    salt: salt.repeat(64).slice(0, 64),
    ...over,
  });

  const voucher = (budgetId: string, payee: string, agent: Keypair, amount: bigint, cumulative: bigint, n: number): Claim => {
    const requestHash = n.toString(16).padStart(64, "0");
    return { budgetId, payee, amount, cumulative, requestHash, signature: signDigest(agent.secretKey, voucherDigest(hub.id, NETWORK, { budgetId, payee, amount, cumulative, requestHash })) };
  };

  const fieldsOf = (c: Claim, callId: number): ReceiptFields => ({
    callId: callId.toString(16).padStart(64, "0"),
    budgetId: c.budgetId,
    payee: c.payee,
    amount: c.amount,
    cumulative: c.cumulative,
    requestHash: c.requestHash,
    timestampMs: 1_800_000_000_000n + BigInt(callId),
    voucherSig: c.signature,
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (err instanceof ChainError) return err.code;
      throw err;
    }
    return "OK";
  };

  const assertSolvent = async () => {
    const [balance, t] = await Promise.all([chain.balanceOf(hub.id), chain.totals()]);
    expect(balance).toBe(t.escrow + t.credits + t.inFlight);
  };

  beforeAll(async () => {
    // Detached, because near-kit then discards the node's output. Attached, it pipes stdout and stderr to this process
    // without reading them, and once the pipe fills the node blocks on a log write and stops producing blocks.
    sandbox = await Sandbox.start({ version: "2.14.0", binaryPath: sandboxBinary(), detached: true });
    root = new Near({ network: sandbox });
    [hub, admin, token, node, alice, bob, seller] = await Promise.all([
      actor("hub", "30 NEAR"),
      actor("admin", "5 NEAR"),
      actor("usdc", "30 NEAR"),
      actor("node", "10 NEAR"),
      actor("alice", "10 NEAR"),
      actor("bob", "10 NEAR"),
      actor("seller", "5 NEAR"),
    ]);

    // The mock NEP-141 stands in for testnet USDC, in sandbox only.
    const ft = readFileSync(join(ROOT_DIR, "contracts-near", "out", "mock_ft.wasm"));
    await token.near.transaction(token.id).deployContract(token.id, ft).functionCall(token.id, "new", {}, { gas: "30 Tgas" }).send({ waitUntil: "FINAL" });
    for (const who of [alice, bob, seller]) await token.near.call(token.id, "mint", { account_id: who.id, amount: "1000" }, { signerId: token.id, waitUntil: "FINAL" });

    report = await deployHub({
      network: "sandbox",
      rpcUrl: sandbox.rpcUrl,
      hub: hub.id,
      admin: admin.id,
      token: token.id,
      settler: node.id,
      checkoutKey: CHECKOUT.publicKey,
      hubKey: hub.key.secretKey,
      adminKey: admin.key.secretKey,
      settlerKey: node.key.secretKey,
      log: () => {},
    });

    // The node settles with a function-call key limited to settle_batch and payout on the hub.
    const nodeKey = generateKey();
    await node.near
      .transaction(node.id)
      .addKey(nodeKey.publicKey.toString(), { type: "functionCall", receiverId: hub.id, methodNames: ["settle_batch", "payout"], allowance: "1 NEAR" })
      .send({ waitUntil: "FINAL" });
    chain = new NearRpcChain({ hub: hub.id, token: token.id, network: NETWORK, rpcUrl: sandbox.rpcUrl, operator: node.id, operatorKey: nodeKey.secretKey });
    reader = new NearRpcChain({ hub: hub.id, token: token.id, network: NETWORK, rpcUrl: sandbox.rpcUrl, operator: node.id });
  }, 240_000);

  afterAll(async () => {
    await sandbox?.stop();
  });

  it("the deploy script registered the hub at the token, set the settler and checkout key, prefunded storage, and locked the hub", async () => {
    expect(report.locked).toBe(true);
    expect(Object.keys(report.steps)).toEqual(["deploy_and_init", "register_hub_at_token", "set_settler", "set_checkout_key", "fund_settler_storage", "register_receipt_key", "lock"]);
    expect(Object.values(report.steps).every((s) => s !== "planned" && s !== "skipped" && s !== "left to the settler")).toBe(true);
    expect((await root.getAccount(hub.id)).codeHash).toBe(report.codeHash);
    expect((await root.getAccessKeys(hub.id)).keys).toHaveLength(0);
    expect(await chain.config()).toEqual({ admin: admin.id, token: token.id, network: NETWORK });
    expect(await chain.isSettler(node.id)).toBe(true);
    expect(await chain.isRegistered(hub.id)).toBe(true);
    expect(reader.readOnly).toBe(true);

    // The settler's storage is prepaid, its receipt key is on the hub, and it pays for checkout payments.
    expect(report.receiptKeyRegistered).toBe(true);
    expect(await reader.receiptKeys(node.id)).toEqual([CHECKOUT.publicKey]);
    expect(await reader.receiptKeys(alice.id)).toEqual([]);
    expect(await reader.checkoutSettler()).toBe(node.id);
    // The admin prefunded 1 NEAR: the balance entry itself and the receipt key came out of it, nothing else.
    const prefunded = 10n ** 24n - storageCost(storageBytes.storageBalance(node.id) + storageBytes.receiptKeys(node.id, 1));
    expect(await reader.storageOf(node.id)).toBe(prefunded);
    expect(report.settlerStorageYocto).toBe(prefunded.toString());
    expect(prefunded).toBeGreaterThan(maxSettleBatchStorageCost(100));

    // A second run finds every step done and changes nothing.
    const again = await deployHub({ network: "sandbox", rpcUrl: sandbox.rpcUrl, hub: hub.id, admin: admin.id, token: token.id, settler: node.id, checkoutKey: CHECKOUT.publicKey, hubKey: hub.key.secretKey, adminKey: admin.key.secretKey, log: () => {} });
    expect(Object.values(again.steps).every((s) => s === "skipped")).toBe(true);
    expect(await reader.storageOf(node.id)).toBe(prefunded);
  });

  it("settles a seller's own voucher only with the node's acceptance, through the builders (review F1 and F2)", async () => {
    // Accounts of this test's own, so the credits it leaves do not touch the other tests.
    const [shop, mallory] = await Promise.all([actor("shop", "5 NEAR"), actor("mallory", "5 NEAR")]);
    const ta = terms(alice.id, agentA, "e5");
    const a = budgetIdOf(hub.id, NETWORK, ta);
    await sendWalletTx(alice.near, alice.id, openBudgetTx(hub.id, ta, ONE_NEAR.toString()));
    await sendWalletTx(alice.near, alice.id, depositBudgetTx(token.id, hub.id, a, 100n));
    const nowS = BigInt(Math.floor(Date.now() / 1000));

    // The node accepted this call for the shop, and gave it the acceptance in the receipt.
    const served = voucher(a, shop.id, agentA, 60n, 60n, 200);
    const servedAcceptance = signAcceptance(CHECKOUT, served, nowS);

    // F1: the owner chose the agent key. A voucher to itself, or to an accomplice with no acceptance, does not settle.
    const toSelf = voucher(a, alice.id, agentA, 100n, 100n, 201);
    expect(await code(sendWalletTx(alice.near, alice.id, settleOwnTx(hub.id, toSelf, signAcceptance(CHECKOUT, toSelf, nowS))))).toBe("PAYEE_IS_OWNER");
    const toAccomplice = voucher(a, mallory.id, agentA, 100n, 100n, 202);
    expect(await code(sendWalletTx(mallory.near, mallory.id, settleOwnTx(hub.id, toAccomplice, signAcceptance(agentA, toAccomplice, nowS))))).toBe("ACCEPTANCE_KEY_UNKNOWN");
    expect(await code(sendWalletTx(mallory.near, mallory.id, settleOwnTx(hub.id, toAccomplice, servedAcceptance)))).toBe("BAD_ACCEPTANCE");
    expect((await chain.budget(a))!.escrow).toBe(100n);

    // F2: after the revoke, a voucher signed with the agent key cannot settle, whatever acceptance comes with it.
    await sendWalletTx(alice.near, alice.id, revokeBudgetTx(hub.id, a));
    const revokedAt = (await chain.budget(a))!.revokedAt!;
    const stolen = voucher(a, mallory.id, agentA, 100n, 100n, 203);
    expect(await code(sendWalletTx(mallory.near, mallory.id, settleOwnTx(hub.id, stolen, signAcceptance(CHECKOUT, stolen, revokedAt / 1000n + 1n))))).toBe("ACCEPTANCE_TOO_LATE");
    expect(await chain.creditOf(mallory.id)).toBe(0n);

    // The shop, served before the revoke, settles by itself inside the grace period, and its credit is real.
    await sendWalletTx(shop.near, shop.id, settleOwnTx(hub.id, served, servedAcceptance));
    expect(await chain.creditOf(shop.id)).toBe(60n);
    expect((await chain.budget(a))!.escrow).toBe(40n);
    expect(await code(sendWalletTx(shop.near, shop.id, settleOwnTx(hub.id, served, servedAcceptance)))).toBe("STALE_VOUCHER");
    await assertSolvent();
  }, 180_000);

  it("charges a batch's storage to the settler's prepaid balance, never to the hub, and returns it on payout (review F3)", async () => {
    const hubNear = async () => {
      const a = await root.rpc.call<{ amount: string; storage_usage: number }>("query", { request_type: "view_account", finality: "final", account_id: hub.id });
      return { amount: BigInt(a.amount), bytes: a.storage_usage };
    };
    /** The hub's own NEAR: its balance, less what its storage locks, less the storage balance it holds for the node. */
    const hubOwn = async () => {
      const [n, held] = [await hubNear(), await chain.storageOf(node.id)];
      return n.amount - storageCost(n.bytes) - held;
    };
    const payees = Array.from({ length: 5 }, (_, i) => `fresh${i}.${sandbox.rootAccount.id}`);
    for (const p of payees) await token.near.call(token.id, "register", { account_id: p }, { signerId: token.id, waitUntil: "FINAL" });
    const tb = terms(bob.id, agentB, "f6");
    const b = budgetIdOf(hub.id, NETWORK, tb);
    await sendWalletTx(bob.near, bob.id, openBudgetTx(hub.id, tb, ONE_NEAR.toString()));
    await sendWalletTx(bob.near, bob.id, depositBudgetTx(token.id, hub.id, b, 50n));

    const [ownBefore, nearBefore, prepaidBefore] = [await hubOwn(), await hubNear(), await chain.storageOf(node.id)];
    const claims = payees.map((p, i) => voucher(b, p, agentB, 2n, 2n, 300 + i));
    await chain.settle({ batchId: "08".repeat(32), root: "ee".repeat(32), claims, expectedNet: computeNetting(payees.map((p) => ({ owner: bob.id, payee: p, delta: 2n }))).entries });
    const [nearAfter, prepaidAfter] = [await hubNear(), await chain.storageOf(node.id)];
    const written = payees.reduce((sum, p) => sum + storageBytes.settled(p) + storageBytes.credit(p, node.id), storageBytes.batch(node.id));
    expect(nearAfter.bytes - nearBefore.bytes).toBe(written);
    expect(prepaidBefore - prepaidAfter).toBe(storageCost(written));
    expect(await hubOwn()).toBe(ownBefore);

    // Paying the creditors out removes their credit entries, and the settler that paid for them gets that storage back.
    await chain.payout(payees);
    const freed = payees.reduce((sum, p) => sum + storageBytes.credit(p, node.id), 0);
    expect((await hubNear()).bytes).toBe(nearAfter.bytes - freed);
    expect((await chain.storageOf(node.id)) - prepaidAfter).toBe(storageCost(freed));
    // The one thing the hub spends is the single yoctoNEAR that NEP-141 requires on each transfer.
    expect(await hubOwn()).toBe(ownBefore - BigInt(payees.length));

    // With nothing prepaid the hub refuses the batch whole. Anyone can fund the settler again.
    const prepaid = await chain.storageOf(node.id);
    await sendWalletTx(node.near, node.id, withdrawStorageTx(hub.id, prepaid));
    expect(await chain.storageOf(node.id)).toBe(0n);
    const next = { batchId: "09".repeat(32), root: "ee".repeat(32), claims: [voucher(b, payees[0]!, agentB, 1n, 3n, 310)], expectedNet: computeNetting([{ owner: bob.id, payee: payees[0]!, delta: 1n }]).entries };
    expect(await code(chain.settle(next))).toBe("INSUFFICIENT_STORAGE");
    expect(await chain.batch(next.batchId)).toBeNull();
    expect(await chain.settledOf(b, payees[0]!)).toBe(2n);
    await sendWalletTx(alice.near, alice.id, fundStorageTx(hub.id, node.id, prepaid));
    expect(await chain.storageOf(node.id)).toBe(prepaid);
    await chain.settle(next);
    expect(await chain.settledOf(b, payees[0]!)).toBe(3n);
    await assertSolvent();
  }, 240_000);

  it("opens, funds, settles with offset, proves, pays out and funds from credit through the seam", async () => {
    // Owners open and fund Budgets from their own wallets, through the pure builders.
    const ta = terms(alice.id, agentA, "a1");
    const tb = terms(bob.id, agentB, "b2");
    const a = budgetIdOf(hub.id, NETWORK, ta);
    const b = budgetIdOf(hub.id, NETWORK, tb);
    await sendWalletTx(alice.near, alice.id, openBudgetTx(hub.id, ta, ONE_NEAR.toString()));
    await sendWalletTx(bob.near, bob.id, openBudgetTx(hub.id, tb, ONE_NEAR.toString()));
    await sendWalletTx(alice.near, alice.id, depositBudgetTx(token.id, hub.id, a, 5n));
    await sendWalletTx(bob.near, bob.id, depositBudgetTx(token.id, hub.id, b, 5n));
    expect(await chain.budget(a)).toMatchObject({ id: a, owner: alice.id, agentPk: agentA.publicKey, settler: node.id, cap: 1_000n, spent: 0n, escrow: 5n, revokedAt: null });
    expect(await chain.budget("ff".repeat(32))).toBeNull();
    await assertSolvent();

    // Calls: alice's agent pays bob 40 then 60, bob's agent pays alice 98. Each claim is the latest voucher of its pair.
    const a1 = voucher(a, bob.id, agentA, 40n, 40n, 1);
    const a2 = voucher(a, bob.id, agentA, 60n, 100n, 2);
    const b1 = voucher(b, alice.id, agentB, 98n, 98n, 3);
    const batchId = "01".repeat(32);
    const tree = buildReceiptTree(hub.id, NETWORK, batchId, [fieldsOf(a1, 1), fieldsOf(a2, 2), fieldsOf(b1, 3)]);
    const { gross, net, entries } = computeNetting([
      { owner: alice.id, payee: bob.id, delta: 100n },
      { owner: bob.id, payee: alice.id, delta: 98n },
    ]);
    const args = { batchId, root: tree.root, claims: [a2, b1], expectedNet: entries };

    // Without offset the same gross does not fit in escrow: one side alone is refused and changes nothing.
    expect(await code(chain.settle({ batchId: "02".repeat(32), root: tree.root, claims: [a2], expectedNet: computeNetting([{ owner: alice.id, payee: bob.id, delta: 100n }]).entries }))).toBe("INSUFFICIENT_ESCROW");
    expect(await chain.batch("02".repeat(32))).toBeNull();

    // The read-only client never signs.
    await expect(reader.settle(args)).rejects.toMatchObject({ kind: "read_only" });
    await expect(reader.settle(args)).rejects.toBeInstanceOf(NearRpcError);

    const hash = await chain.settle(args);
    expect(await chain.txState(hash)).toEqual({ status: "final" });
    expect(await chain.batch(batchId)).toMatchObject({ root: tree.root, settler: node.id, gross, net });
    expect(gross).toBe(198n);
    expect(net).toBe(2n);
    expect(await chain.settledOf(a, bob.id)).toBe(100n);
    expect(await chain.settledOf(b, alice.id)).toBe(98n);
    expect(await chain.creditOf(bob.id)).toBe(2n);
    expect(await chain.budget(a)).toMatchObject({ spent: 100n, escrow: 3n });
    await assertSolvent();

    // Retrying the same settlement is refused cleanly by the hub and leaves the first result in place.
    expect(await code(chain.settle(args))).toBe("BATCH_EXISTS");
    expect(await chain.batch(batchId)).toMatchObject({ root: tree.root, gross: 198n });
    expect(await chain.creditOf(bob.id)).toBe(2n);
    // A replayed voucher under a new batch id is stale.
    expect(await code(chain.settle({ ...args, batchId: "03".repeat(32) }))).toBe("STALE_VOUCHER");
    expect(await chain.txState("11111111111111111111111111111111")).toEqual({ status: "unknown" });

    // Every receipt proves against the stored root, from the read-only client too, and a tampered one does not.
    for (const r of tree.receipts) {
      expect(await reader.verifyReceipt(batchId, r, tree.proofOf(r.callId))).toBe(true);
    }
    const first = tree.receipts[0]!;
    expect(await reader.verifyReceipt(batchId, { ...first, amount: first.amount + 1n }, tree.proofOf(first.callId))).toBe(false);
    expect(await reader.verifyReceipt("09".repeat(32), first, tree.proofOf(first.callId))).toBe(false);

    // Bob moves his earned credit into his own Budget's escrow from his wallet: escrow rises, cap does not.
    const before = await chain.totals();
    await sendWalletTx(bob.near, bob.id, fundFromCreditTx(hub.id, b, 2n));
    expect(await chain.creditOf(bob.id)).toBe(0n);
    expect(await chain.budget(b)).toMatchObject({ escrow: 7n, cap: 1_000n });
    const after = await chain.totals();
    expect(after.escrow + after.credits).toBe(before.escrow + before.credits);
    expect(await code(sendWalletTx(bob.near, bob.id, fundFromCreditTx(hub.id, b, 1n)))).toBe("INSUFFICIENT_CREDIT");
    expect(await code(sendWalletTx(alice.near, alice.id, fundFromCreditTx(hub.id, b, 1n)))).toBe("NOT_OWNER");
    await assertSolvent();

    // Alice's agent pays the seller, and payout moves real tokens to the seller.
    const s1 = voucher(a, seller.id, agentA, 3n, 3n, 4);
    await chain.settle({ batchId: "04".repeat(32), root: tree.root, claims: [s1], expectedNet: computeNetting([{ owner: alice.id, payee: seller.id, delta: 3n }]).entries });
    expect(await chain.creditOf(seller.id)).toBe(3n);
    const sellerBefore = await chain.balanceOf(seller.id);
    const payoutHash = await chain.payout([seller.id]);
    expect(await chain.txState(payoutHash)).toEqual({ status: "final" });
    expect(await chain.balanceOf(seller.id)).toBe(sellerBefore + 3n);
    expect(await chain.creditOf(seller.id)).toBe(0n);
    expect((await chain.totals()).inFlight).toBe(0n);
    // Paying out again is harmless.
    await chain.payout([seller.id]);
    expect(await chain.balanceOf(seller.id)).toBe(sellerBefore + 3n);
    await assertSolvent();

    // Revoking from the owner's wallet closes the Budget to new funding, from credit included.
    await sendWalletTx(alice.near, alice.id, revokeBudgetTx(hub.id, a));
    expect((await chain.budget(a))!.revokedAt).not.toBeNull();
    expect(await code(sendWalletTx(alice.near, alice.id, fundFromCreditTx(hub.id, a, 1n)))).toBe("BUDGET_NOT_OPEN");
  }, 240_000);

  it("sends a settlement exactly once when the RPC drops or stalls the reply, and a retry is refused cleanly", async () => {
    // A proxy in front of the sandbox forwards every request, and for send_tx it forwards and then loses the reply.
    let sends = 0;
    let mode: "drop" | "stall" | "pass" = "drop";
    const proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString();
      const isSend = JSON.parse(body).method === "send_tx";
      if (isSend) sends++;
      const upstream = await fetch(sandbox.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await upstream.text();
      if (isSend) {
        if (mode === "drop") return res.destroy();
        if (mode === "stall") return; // never answer
      }
      res.writeHead(upstream.status, { "content-type": "application/json" }).end(text);
    });
    await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      const nodeKey = generateKey();
      await node.near
        .transaction(node.id)
        .addKey(nodeKey.publicKey.toString(), { type: "functionCall", receiverId: hub.id, methodNames: ["settle_batch", "payout"], allowance: "1 NEAR" })
        .send({ waitUntil: "FINAL" });
      const through = (writeTimeoutMs: number) =>
        new NearRpcChain({ hub: hub.id, token: token.id, network: NETWORK, rpcUrl: url, operator: node.id, operatorKey: nodeKey.secretKey, writeTimeoutMs });
      const flaky = through(60_000);
      const finalState = async (hash: string) => {
        for (let i = 0; i < 60; i++) {
          const s = await chain.txState(hash);
          if (s.status !== "pending" && s.status !== "unknown") return s;
          await new Promise((ok) => setTimeout(ok, 500));
        }
        return chain.txState(hash);
      };

      const tb = terms(bob.id, agentB, "c3");
      const b = budgetIdOf(hub.id, NETWORK, tb);
      await sendWalletTx(bob.near, bob.id, openBudgetTx(hub.id, tb, ONE_NEAR.toString()));
      await sendWalletTx(bob.near, bob.id, depositBudgetTx(token.id, hub.id, b, 20n));
      const settleOf = (batchId: string, c: Claim) => ({ batchId, root: "ee".repeat(32), claims: [c], expectedNet: computeNetting([{ owner: bob.id, payee: seller.id, delta: c.amount }]).entries });

      // Dropped reply: the error says the outcome is unknown and names the transaction, and nothing was resent.
      const dropped = settleOf("05".repeat(32), voucher(b, seller.id, agentB, 4n, 4n, 10));
      const err = await flaky.settle(dropped).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NearRpcError);
      expect(err).toMatchObject({ kind: "unavailable", outcomeUnknown: true });
      const hash = (err as NearRpcError).txHash!;
      expect(hash).toBeTruthy();
      expect(sends).toBe(1);
      // The transaction landed, and settling the same batch again, once the RPC answers, is refused without changes.
      expect(await finalState(hash)).toEqual({ status: "final" });
      expect(await chain.batch(dropped.batchId)).toMatchObject({ gross: 4n });
      mode = "pass";
      expect(await code(flaky.settle(dropped))).toBe("BATCH_EXISTS");
      expect(sends).toBe(2);
      expect(await chain.creditOf(seller.id)).toBe(4n);

      // Stalled reply: the deadline turns into a timeout with the hash, again with exactly one send.
      mode = "stall";
      const stalled = settleOf("06".repeat(32), voucher(b, seller.id, agentB, 5n, 9n, 11));
      const late = await through(3_000)
        .settle(stalled)
        .catch((e: unknown) => e);
      expect(late).toMatchObject({ kind: "timeout", outcomeUnknown: true });
      expect(sends).toBe(3);
      expect(await finalState((late as NearRpcError).txHash!)).toEqual({ status: "final" });
      expect(await chain.batch(stalled.batchId)).toMatchObject({ gross: 5n });
      await assertSolvent();
    } finally {
      proxy.closeAllConnections();
      proxy.close();
    }
  }, 120_000);

  it("pays out to 10 creditors in one payout through NearRpcChain, with the gas the client itself attaches (review F4)", async () => {
    // The client attaches more than the hub's own requirement, which is itself above what the call really burns.
    expect(payoutGasNeededTgas(10)).toBe(270);
    expect(payoutGasTgas(10)).toBe(300);
    expect(payoutGasTgas(1)).toBeGreaterThan(payoutGasNeededTgas(1));
    for (let n = 1; n <= 10; n++) expect(payoutGasTgas(n)).toBeGreaterThanOrEqual(payoutGasNeededTgas(n) + 12);
    const payees = Array.from({ length: 10 }, (_, i) => `payee${i}.${sandbox.rootAccount.id}`);
    for (const p of payees) await token.near.call(token.id, "register", { account_id: p }, { signerId: token.id, waitUntil: "FINAL" });
    const ta = terms(alice.id, agentA, "d4");
    const a = budgetIdOf(hub.id, NETWORK, ta);
    await sendWalletTx(alice.near, alice.id, openBudgetTx(hub.id, ta, ONE_NEAR.toString()));
    await sendWalletTx(alice.near, alice.id, depositBudgetTx(token.id, hub.id, a, 10n));
    const claims = payees.map((p, i) => voucher(a, p, agentA, 1n, 1n, 100 + i));
    await chain.settle({ batchId: "07".repeat(32), root: "ee".repeat(32), claims, expectedNet: computeNetting(payees.map((p) => ({ owner: alice.id, payee: p, delta: 1n }))).entries });
    for (const p of payees) expect(await chain.creditOf(p)).toBe(1n);

    const hash = await chain.payout(payees);
    expect(await chain.txState(hash)).toEqual({ status: "final" });
    for (const p of payees) {
      expect(await chain.balanceOf(p)).toBe(1n);
      expect(await chain.creditOf(p)).toBe(0n);
    }
    expect((await chain.totals()).inFlight).toBe(0n);
    await assertSolvent();
  }, 180_000);

  it("maps refusals and RPC failures onto typed errors", async () => {
    expect(await code(chain.payout(Array.from({ length: 11 }, (_, i) => `p${i}.test.near`)))).toBe("TOO_MANY_ACCOUNTS");
    const offline = new NearRpcChain({ hub: hub.id, token: token.id, network: NETWORK, rpcUrl: "http://127.0.0.1:9", operator: node.id, readTimeoutMs: 5_000 });
    await expect(offline.creditOf(alice.id)).rejects.toMatchObject({ kind: "unavailable", outcomeUnknown: false });
    const missing = new NearRpcChain({ hub: `nohub.${sandbox.rootAccount.id}`, token: token.id, network: NETWORK, rpcUrl: sandbox.rpcUrl, operator: node.id });
    await expect(missing.creditOf(alice.id)).rejects.toBeInstanceOf(NearRpcError);
  }, 60_000);
});
