/**
 * The gateway on NEAR end to end through FakeChain, over HTTP: merchants proven with NEP-413 payout proofs, the hosted
 * checkout paid by a shopper's wallet with node-signed terms through the hub, payment proofs read from the chain,
 * refunds the merchant sends itself, agents paying links over x402 v2 with vouchers (single and split), and the
 * reconciliation report.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { decodeHeader, encodeHeader, HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE, SCHEME, sha256Text, X402_VERSION, type Policy } from "@payminto/protocol";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import type { GatewayConfig } from "../src/config.ts";
import { FakeNearRpc, OWNER_A, openBudget, payoutAccount, payoutProof, signVoucher, startFakeChain, tempDir, testConfig, testKey, type OpenedBudget } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const SHOP = payoutAccount("shop.testnet", 70);
const BETA = payoutAccount("beta.testnet", 71);
const SHOPPER = "shopper.testnet";
const FEES = "fees.testnet";
const tmp = tempDir("payminto-gateway-");
const rpc = new FakeNearRpc().addKey(BETA.account, BETA.key.publicKey).addKey(SHOP.account, SHOP.key.publicKey);
let chain: FakeChain;
let node: ClearingNode;
let shopId: string;

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, auth: string | null = ADMIN) => {
  const r = await fetch(`${node.url}${path}`, {
    method,
    // The recovery key acts for the seeded business unless a test names another (the node has two once Beta exists).
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(auth && shopId ? { "merchant-id": shopId } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    // CSV and other text bodies.
  }
  return { status: r.status, json, text, headers: r.headers };
};
const scope = () => ({ network: chain.network, hub: chain.hub });

beforeAll(async () => {
  chain = startFakeChain([OWNER_A, SHOPPER]);
  // Payouts need token registration (NEP-145), which the account holder pays for; the platform fee account too.
  for (const a of [SHOP.account, FEES]) chain.register(a);
  const gateway: GatewayConfig = { seedPayout: SHOP.account, platformName: "Acme", feeRecipient: FEES, checkoutBaseUrl: "http://localhost:3000", checkoutTtlSec: 1800, webhookAllowPrivate: true, watchIntervalMs: 2000 };
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN, gateway, publicUrl: "http://node.test" }), { chain, nearRpc: rpc, logger: silentLogger, port: 0, workers: false });
  // The operator sets the node's checkout key on the hub (`set_checkout_key`), as the deployment guide says, and the
  // node's account registers the same key as its receipt key (`register_receipt_key`), which settle_own checks.
  chain.setCheckoutKey(node.services.chain.nodeKey);
  await chain.registerReceiptKey(chain.operator, node.services.chain.nodeKey);
  shopId = (await call("GET", "/v1/merchant")).json.id;
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("payout accounts proven with NEP-413", () => {
  it("creates a business whose payout signed the proof with a full-access key of that account", async () => {
    const r = await call("POST", "/v1/merchants", { name: "Beta", payout: payoutProof(BETA, "new", scope()) });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ payout: BETA.account, network: chain.network, hub: chain.hub, token: chain.token, checkout_key: node.services.chain.nodeKey });
    expect(r.json.payout_history[0]).toMatchObject({ new_payout: BETA.account, proven: true, public_key: BETA.key.publicKey });
  });

  it("refuses a proof for another merchant, a stale one, a function-call key and a key the account does not have", async () => {
    const stranger = payoutAccount("stranger.testnet", 72);
    const code = async (proof: unknown, path = "/v1/merchants", body: Record<string, unknown> = { name: "X" }) => (await call("POST", path, path === "/v1/merchants" ? { ...body, payout: proof } : proof)).json.error.code;
    expect(await code(payoutProof(BETA, "mer_other", scope()))).toBe("PAYOUT_PROOF_INVALID");
    expect(await code(payoutProof(BETA, "new", { ...scope(), hub: "other-hub.testnet" }))).toBe("PAYOUT_PROOF_INVALID");
    expect(await code(payoutProof(BETA, "new", scope(), Math.floor(Date.now() / 1000) - 3600))).toBe("PAYOUT_PROOF_EXPIRED");
    expect(await code(payoutProof(stranger, "new", scope()))).toBe("PAYOUT_PROOF_INVALID");
    rpc.addKey(stranger.account, stranger.key.publicKey, "function_call");
    const fc = await call("POST", "/v1/merchants", { name: "X", payout: payoutProof(stranger, "new", scope()) });
    expect(fc.json.error).toMatchObject({ code: "PAYOUT_PROOF_INVALID", message: expect.stringMatching(/function-call key/) });
    // A proof by the right key for the wrong account (claiming BETA's account with the stranger's key).
    const forged = { ...payoutProof(stranger, "new", scope()), payout: BETA.account };
    expect(await code(forged)).toBe("PAYOUT_PROOF_INVALID");
  });

  it("changes a payout with a proof bound to the merchant id", async () => {
    const r = await call("POST", `/v1/merchants/${shopId}/payout`, payoutProof(SHOP, shopId, scope()));
    expect(r.status).toBe(200);
    expect(r.json.payout_history.map((h: { proven: boolean }) => h.proven)).toEqual([true, false]);
  });
});

describe("hosted checkout paid from a NEAR wallet", () => {
  let paymentId = "";

  it("hands the shopper's wallet node-signed terms, records the hub's payment and proves it from the chain", async () => {
    const created = await call("POST", "/v1/payments", { amount: "2500000", description: "Pro plan", reference: "inv-9" });
    expect(created.status, created.text).toBe(201);
    paymentId = created.json.id;
    expect(created.json).toMatchObject({ network: chain.network, hub: chain.hub, token: chain.token, payout: SHOP.account, checkout_id: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const view = (await call("GET", `/v1/checkout/${paymentId}`, undefined, {}, null)).json;
    expect(view).toMatchObject({ methods: ["wallet"], amount_remaining: "2500000", network: chain.network });
    expect(view.wallet.terms).toEqual({ payment_id: created.json.checkout_id, merchant: SHOP.account, amount: "2500000", expiry_ms: String(Date.parse(created.json.expires_at)) });
    const tx = view.wallet.transaction;
    expect(tx).toMatchObject({ receiverId: chain.token, actions: [{ params: { methodName: "ft_transfer_call", deposit: "1" } }] });

    // The shopper's wallet sends it; the hub checks the node's signature and credits the merchant.
    const args = tx.actions[0].params.args as { receiver_id: string; amount: string; msg: string };
    expect(chain.ftTransferCall(SHOPPER, BigInt(args.amount), args.msg).refunded).toBe(0n);
    const reported = await call("POST", `/v1/checkout/${paymentId}/wallet`, { tx_hash: "8vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx" }, {}, null);
    expect(reported.json).toMatchObject({ status: "paid", recorded: true, payment: { status: "paid", methods: [], wallet: null, tx_hash: "8vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx" } });

    const detail = (await call("GET", `/v1/payments/${paymentId}`)).json;
    expect(detail).toMatchObject({ status: "paid", amount_paid: "2500000", payer: SHOPPER, method: "wallet" });
    expect(detail.credits).toMatchObject([{ method: "wallet", payer: SHOPPER, status: "confirmed", tx_hash: "8vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx" }]);

    const proof = (await call("GET", `/v1/checkout/${paymentId}/proof`, undefined, {}, null)).json;
    expect(proof).toMatchObject({ status: "paid", network: chain.network, hub: chain.hub, payout: SHOP.account });
    expect(proof.credits).toEqual([
      {
        method: "wallet",
        amount: "2500000",
        payer: SHOPPER,
        checkout_id: created.json.checkout_id,
        // The transaction the payer's wallet reported: shown so a person can find it, while the hub record is the proof.
        tx_hash: "8vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx",
        hub_record: { merchant: SHOP.account, amount: "2500000", payer: SHOPPER, at_ms: chain.nowMs.toString() },
        verified: true,
      },
    ]);
    // The order commitment is the exact bytes order_hash hashes.
    const order = await call("GET", `/v1/checkout/${paymentId}/order`, undefined, {}, null);
    expect(sha256Text(order.text)).toBe(detail.order_hash);
  });

  it("keeps the gateway's own provider records out of the public list of paid services", async () => {
    // Each merchant gets a provider row the gateway clears voucher payments against; it is plumbing, not a service.
    const internal = node.services.db.all<{ id: string }>("SELECT id FROM providers WHERE category = 'gateway'");
    expect(internal.length).toBeGreaterThan(0);
    const listed = (await call("GET", "/v1/providers", undefined, {}, null)).json as Array<{ id: string }>;
    for (const p of internal) expect(listed.map((x) => x.id)).not.toContain(p.id);
  });

  it("queues the merchant's hub credit for payout and pays it out", async () => {
    const out = (await call("POST", "/v1/payouts")).json;
    expect(out.payouts, JSON.stringify(out)).toBeDefined();
    expect(out.payouts[0].items).toEqual([expect.objectContaining({ account: SHOP.account, paid: "2500000", outcome: "paid" })]);
    expect(await chain.balanceOf(SHOP.account)).toBe(2_500_000n);
    chain.solvency();
  });

  it("refunds from the merchant's own wallet, checked against the transaction it submits", async () => {
    const r = await call("POST", "/v1/refunds", { paymentId, amount: "500000", reason: "partial" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ to: SHOPPER, status: "pending", method: null });
    expect(r.json.transfer).toEqual({
      receiverId: chain.token,
      actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: SHOPPER, amount: "500000", memo: `payminto refund ${r.json.id}` }, gas: "30000000000000", deposit: "1" } }],
    });
    // A transaction that pays the wrong amount fails the refund.
    rpc.txs.set("refund-tx-wrong", { status: "final", signer: SHOP.account, transfers: [{ token: chain.token, receiverId: SHOPPER, amount: 400_000n }] });
    const wrong = await call("POST", `/v1/refunds/${r.json.id}/submit`, { txHash: "refund-tx-wrong" });
    expect(wrong.json).toMatchObject({ status: "failed", failure_reason: expect.stringMatching(/no ft_transfer of 500000/) });

    const again = await call("POST", "/v1/refunds", { paymentId, amount: "500000" });
    // Not final yet: still pending, then final with the right transfer.
    rpc.txs.set("refund-tx-good", { status: "pending" });
    expect((await call("POST", `/v1/refunds/${again.json.id}/submit`, { txHash: "refund-tx-good" })).json).toMatchObject({ status: "pending", tx_hash: "refund-tx-good", method: "transfer" });
    rpc.txs.set("refund-tx-good", { status: "final", signer: SHOP.account, transfers: [{ token: chain.token, receiverId: SHOPPER, amount: 500_000n }] });
    await node.services.gateway!.refunds.tick();
    expect((await call("GET", `/v1/refunds/${again.json.id}`)).json).toMatchObject({ status: "succeeded", verification: "transfer_checked", transfer: null });
    expect((await call("GET", `/v1/payments/${paymentId}`)).json).toMatchObject({ amount_refunded: "500000", refund_status: "partial" });
    // One transaction proves one refund only.
    const third = await call("POST", "/v1/refunds", { paymentId, amount: "1" });
    expect((await call("POST", `/v1/refunds/${third.json.id}/submit`, { txHash: "refund-tx-good" })).json.error.code).toBe("TX_ALREADY_USED");
  });

  it("offers no wallet terms once a payment expired, and re-quotes for the wallet on request", async () => {
    const p = (await call("POST", "/v1/payments", { amount: "10000", expires_in: 300 })).json;
    node.services.db.run("UPDATE payments SET expires_unix = ? WHERE id = ?", Math.floor(Date.now() / 1000) - 1, p.id);
    expect((await call("GET", `/v1/checkout/${p.id}`, undefined, {}, null)).json).toMatchObject({ methods: [], wallet: null });
    const q = (await call("POST", "/v1/payments", { amount: "10000", method: "voucher" })).json;
    expect((await call("GET", `/v1/checkout/${q.id}`, undefined, {}, null)).json.wallet).toBeNull();
    expect((await call("POST", `/v1/checkout/${q.id}/method`, { method: "wallet" }, {}, null)).json).toMatchObject({ method: "wallet", wallet: { terms: { amount: "10000" } } });
  });

  it("signs no wallet terms below the node's minimum checkout amount, which the hub would refund", async () => {
    const small = (await call("POST", "/v1/payments", { amount: "9999", expires_in: 300 })).json;
    expect((await call("GET", `/v1/checkout/${small.id}`, undefined, {}, null)).json).toMatchObject({ wallet: null });
    const ok = (await call("POST", "/v1/payments", { amount: "10000", expires_in: 300 })).json;
    expect((await call("GET", `/v1/checkout/${ok.id}`, undefined, {}, null)).json.wallet.terms.amount).toBe("10000");
  });
});

describe("agents paying links over x402 v2", () => {
  const POLICY: Policy = { perCallCap: "5000000", dailyCap: "50000000", maxCallsPerMinute: 0, purpose: "buy" };
  let budget: OpenedBudget;
  let slug = "";
  const cumulative = new Map<string, bigint>();

  type Requirement = { amount: string; payTo: string; extra: { splits?: Array<{ payTo: string; amount: string }> } } & Record<string, unknown>;

  /**
   * The agent side: one voucher per split of the accepted requirement, in the clients stream's wire shape, extending
   * the position the node reports (as the SDK does before it signs).
   */
  const sign = async (accepted: Requirement, b: OpenedBudget, over: Record<string, unknown> = {}) => {
    const splits = accepted.extra.splits ?? [{ payTo: accepted.payTo, amount: accepted.amount }];
    for (const s of splits) cumulative.set(`${b.id}:${s.payTo}`, BigInt((await call("GET", `/v1/budgets/${b.id}/position?payee=${s.payTo}`, undefined, {}, null)).json.cumulative));
    // One request: every voucher of a split binds the same request hash.
    const requestHash = sha256Text(`link-${Math.random()}`);
    const vouchers = splits.map((s) => {
      const next = cumulative.get(`${b.id}:${s.payTo}`)! + BigInt(s.amount);
      const v = { budgetId: b.id, payee: s.payTo, amount: BigInt(s.amount), cumulative: next, requestHash };
      return { budgetId: b.id, payee: s.payTo, amount: s.amount, cumulative: next.toString(), requestHash, publicKey: b.agent.publicKey, signature: signVoucher(chain, b.agent, v) };
    });
    return encodeHeader({ x402Version: X402_VERSION, resource: { url: "x", description: "" }, accepted, payload: vouchers.length === 1 ? vouchers[0] : { vouchers }, ...over });
  };

  beforeAll(async () => {
    budget = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(30), { escrow: 20_000_000n, policy: POLICY });
    slug = (await call("POST", "/v1/links", { title: "Report", amount: "1000000" })).json.slug;
  });

  it("answers an unpaid request with one payminto-voucher requirement in the v2 shape", async () => {
    const r = await call("GET", `/v1/pay/l/${slug}`, undefined, {}, null);
    expect(r.status).toBe(402);
    const pr = decodeHeader<any>(r.headers.get(HEADER_REQUIRED));
    expect(pr).toMatchObject({ x402Version: 2, error: "PAYMENT_REQUIRED", resource: { url: `http://localhost:3000/l/${slug}`, description: "Report" } });
    expect(pr.accepts).toEqual([
      {
        scheme: SCHEME,
        network: chain.network,
        amount: "1000000",
        asset: chain.token,
        payTo: SHOP.account,
        maxTimeoutSeconds: 300,
        extra: { clearingHub: chain.hub, clearingNode: "http://node.test", providerId: expect.stringMatching(/^prv_/), tokenSymbol: "USDC", tokenDecimals: 6 },
      },
    ]);
    expect(r.headers.get(HEADER_RESPONSE)).toBeNull();
  });

  it("accepts a voucher and answers PAYMENT-RESPONSE with the receipt and position, and replays it", async () => {
    const accepted = decodeHeader<any>((await call("GET", `/v1/pay/l/${slug}`, undefined, {}, null)).headers.get(HEADER_REQUIRED)).accepts[0];
    const header = await sign(accepted, budget);
    const r = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: header }, null);
    expect(r.status).toBe(200);
    const pr = decodeHeader<any>(r.headers.get(HEADER_RESPONSE));
    expect(pr).toMatchObject({ success: true, transaction: "", network: chain.network, payer: budget.agent.publicKey, positions: [{ budgetId: budget.id, payee: SHOP.account, cumulative: "1000000" }] });
    expect(pr.receipts).toHaveLength(1);
    expect(pr.receipts[0]).toMatchObject({ budgetId: budget.id, payee: SHOP.account, amount: "1000000", node: node.services.chain.nodeKey });
    expect(r.json).toMatchObject({ status: "processing", receipt: pr.receipts[0] });
    // The same vouchers again: the same receipts, nothing new accepted.
    const replay = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: header }, null);
    expect(replay.status).toBe(200);
    expect(decodeHeader<any>(replay.headers.get(HEADER_RESPONSE)).receipts[0].callId).toBe(pr.receipts[0].callId);
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE budget_id = ?", budget.id)!.n).toBe(1);
  });

  it("refuses with PAYMENT-RESPONSE success false and the refusal the rule produced", async () => {
    const small = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(31), { escrow: 500_000n, policy: POLICY });
    const accepted = decodeHeader<any>((await call("GET", `/v1/pay/l/${slug}`, undefined, {}, null)).headers.get(HEADER_REQUIRED)).accepts[0];
    const r = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: await sign(accepted, small) }, null);
    expect(r.status).toBe(402);
    expect(decodeHeader<any>(r.headers.get(HEADER_RESPONSE))).toEqual({
      success: false,
      errorReason: "NET_EXPOSURE",
      transaction: "",
      network: chain.network,
      refusal: { rule: "NET_EXPOSURE", message: "Unsettled spending of this Budget would exceed its escrow", attemptedAmount: "1000000", remainingBudget: "100000000", retry: { kind: "fund", shortBy: "500000" } },
    });
    expect(decodeHeader<any>(r.headers.get(HEADER_REQUIRED)).accepts).toHaveLength(1);
  });

  it("answers vouchers the Budget's agent key did not sign with a plain error and records nothing for the owner", async () => {
    const count = (table: string) => node.services.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
    const before = { denials: count("denials"), screening: count("screening_decisions") };
    // The owner is on the business's deny list: a believed voucher would be recorded as a blocked payer.
    expect((await call("POST", "/v1/screening/deny-list", { address: OWNER_A, reason: "test" })).status).toBe(201);
    const accepted = decodeHeader<any>((await call("GET", `/v1/pay/l/${slug}`, undefined, {}, null)).headers.get(HEADER_REQUIRED)).accepts[0];
    const forged = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: await sign(accepted, { ...budget, agent: testKey(99) }) }, null);
    expect(forged.status).toBe(402);
    expect(decodeHeader<any>(forged.headers.get(HEADER_RESPONSE))).toEqual({ success: false, errorReason: "BAD_SIGNATURE", transaction: "", network: chain.network });
    expect(forged.json.error).toEqual({ code: "BAD_SIGNATURE", message: "Voucher is not signed by the Budget agent" });
    expect(forged.json.refusal).toBeUndefined();
    expect({ denials: count("denials"), screening: count("screening_decisions") }).toEqual(before);
    expect((await call("DELETE", `/v1/screening/deny-list/${OWNER_A}`)).status).toBeLessThan(300);
  });

  it("refuses another x402 version, a requirement it does not offer and vouchers that do not match it", async () => {
    const accepted = decodeHeader<any>((await call("GET", `/v1/pay/l/${slug}`, undefined, {}, null)).headers.get(HEADER_REQUIRED)).accepts[0];
    const v1 = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: await sign(accepted, budget, { x402Version: 1 }) }, null);
    expect(v1.json.error.code).toBe("UNSUPPORTED_X402_VERSION");
    const cheaper = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: await sign({ ...accepted, amount: "1" }, budget) }, null);
    expect(cheaper.status).toBe(402);
    expect(decodeHeader<any>(cheaper.headers.get(HEADER_RESPONSE))).toMatchObject({ success: false, errorReason: "REQUIREMENT_MISMATCH" });
    const mismatched = JSON.parse(Buffer.from(await sign(accepted, budget), "base64").toString());
    mismatched.payload.payee = BETA.account;
    const bad = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: Buffer.from(JSON.stringify(mismatched)).toString("base64") }, null);
    expect(decodeHeader<any>(bad.headers.get(HEADER_RESPONSE))).toMatchObject({ success: false, errorReason: "INVALID_PAYMENT" });
  });

  it("splits a payment with a platform fee into one requirement with extra.splits, paid with two vouchers at once", async () => {
    const plan = await call("POST", "/v1/fee-plans", { name: "One percent", platform_fee_bps: 100 });
    expect(plan.status).toBe(201);
    await call("PATCH", `/v1/merchants/${shopId}`, { fee_plan_id: plan.json.id });
    const pr = decodeHeader<any>((await call("GET", `/v1/pay/l/${slug}`, undefined, {}, null)).headers.get(HEADER_REQUIRED));
    expect(pr.accepts).toHaveLength(1);
    const accepted = pr.accepts[0];
    expect(accepted).toMatchObject({ amount: "1000000", payTo: SHOP.account });
    expect(accepted.extra.splits).toEqual([
      { payTo: SHOP.account, amount: "990000", providerId: expect.stringMatching(/^prv_/) },
      { payTo: FEES, amount: "10000", providerId: expect.stringMatching(/^prv_/) },
    ]);
    const r = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: await sign(accepted, budget) }, null);
    expect(r.status, r.text).toBe(200);
    expect(decodeHeader<any>(r.headers.get(HEADER_RESPONSE)).receipts.map((x: { payee: string; amount: string }) => [x.payee, x.amount])).toEqual([
      [SHOP.account, "990000"],
      [FEES, "10000"],
    ]);
    // A wallet checkout cannot carry the fee, so it is not offered for this business now.
    const p = (await call("POST", "/v1/payments", { amount: "1000" })).json;
    expect((await call("GET", `/v1/checkout/${p.id}`, undefined, {}, null)).json).toMatchObject({ methods: [], wallet: null });
    await call("PATCH", `/v1/merchants/${shopId}`, { fee_plan_id: "fp_zero" });
  });

  describe("a split payment is one call for the Budget's limits", () => {
    let planId = "";
    const offer = async () => decodeHeader<any>((await call("GET", `/v1/pay/l/${slug}`, undefined, {}, null)).headers.get(HEADER_REQUIRED)).accepts[0];
    const payWith = async (b: OpenedBudget) => call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: await sign(await offer(), b) }, null);
    const callsOf = (b: OpenedBudget) => node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE budget_id = ?", b.id)!.n;

    beforeAll(async () => {
      planId = (await call("POST", "/v1/fee-plans", { name: "One percent again", platform_fee_bps: 100 })).json.id;
      await call("PATCH", `/v1/merchants/${shopId}`, { fee_plan_id: planId });
    });
    afterAll(async () => {
      await call("PATCH", `/v1/merchants/${shopId}`, { fee_plan_id: "fp_zero" });
    });

    it("applies the per-call cap to the total of the request, not to each voucher", async () => {
      // 990,000 to the shop and 10,000 to the platform each fit a 995,000 cap; the 1,000,000 call does not.
      const capped = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(32), { escrow: 20_000_000n, policy: { ...POLICY, perCallCap: "995000" } });
      const r = await payWith(capped);
      expect(r.status, r.text).toBe(402);
      expect(decodeHeader<any>(r.headers.get(HEADER_RESPONSE))).toMatchObject({
        success: false,
        errorReason: "PER_CALL_CAP",
        refusal: { rule: "PER_CALL_CAP", attemptedAmount: "1000000", retry: { kind: "never" } },
      });
      expect(callsOf(capped)).toBe(0);
    });

    it("applies the rolling caps to the total, and names the whole amount in the refusal", async () => {
      // 1,500,000 an hour: one 1,000,000 call fits, the second does not, and it is refused whole on its first voucher.
      const hourly = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(33), { escrow: 20_000_000n, policy: { ...POLICY, hourlyCap: "1500000" } });
      expect((await payWith(hourly)).status).toBe(200);
      const r = await payWith(hourly);
      expect(r.status).toBe(402);
      const refusal = decodeHeader<any>(r.headers.get(HEADER_RESPONSE)).refusal;
      expect(refusal).toMatchObject({ rule: "HOURLY_CAP", attemptedAmount: "1000000", retry: { kind: "after" } });
      expect(refusal.retry.seconds).toBeGreaterThan(3_590);
      expect(refusal.retry.seconds).toBeLessThanOrEqual(3_600);
      expect(callsOf(hourly)).toBe(2);
    });

    it("counts a split as one call for the per-minute and same-request limits", async () => {
      // One call a minute and one payment per request: a split is still one call, and the second request is refused.
      const once = await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(34), { escrow: 20_000_000n, policy: { ...POLICY, maxCallsPerMinute: 1, maxRepeatsPerRequest: 1 } });
      const first = await payWith(once);
      expect(first.status, first.text).toBe(200);
      expect(callsOf(once)).toBe(2);
      const second = await payWith(once);
      expect(second.status).toBe(402);
      const refusal = decodeHeader<any>(second.headers.get(HEADER_RESPONSE)).refusal;
      expect(refusal).toMatchObject({ rule: "RATE_LIMIT", attemptedAmount: "1000000", retry: { kind: "after" } });
      expect(refusal.retry.seconds).toBeGreaterThan(50);
      expect(refusal.retry.seconds).toBeLessThanOrEqual(60);
    });
  });

  it("marks voucher payments paid once their batch settles, and proves them against the hub's root", async () => {
    const paidLinks = node.services.db.all<{ id: string }>("SELECT id FROM payments WHERE link_id IS NOT NULL AND status = 'processing'");
    // The single and the split payment above, and the two split payments the limit tests accepted.
    expect(paidLinks.length).toBe(4);
    // One Budget per owner per batch: OWNER_A paid from three Budgets, so the calls settle in three batches.
    expect((await call("POST", "/v1/settlements")).json.batchIds).toHaveLength(3);
    for (const { id } of paidLinks) {
      const proof = (await call("GET", `/v1/checkout/${id}/proof`, undefined, {}, null)).json;
      expect(proof.status).toBe("paid");
      expect(proof.credits.length).toBeGreaterThan(0);
      for (const c of proof.credits) expect(c).toMatchObject({ method: "voucher", payer: OWNER_A, verified: true, batch_id: expect.stringMatching(/^[0-9a-f]{64}$/), receipt_proof_url: expect.stringMatching(/^http:\/\/node\.test\/v1\/receipts\//) });
    }
  });

  it("marks a voucher payment paid when the business settles the voucher itself, with no batch to prove it against", async () => {
    const accepted = decodeHeader<any>((await call("GET", `/v1/pay/l/${slug}`, undefined, {}, null)).headers.get(HEADER_REQUIRED)).accepts[0];
    const header = await sign(accepted, budget);
    const paid = await call("POST", `/v1/pay/l/${slug}`, undefined, { [HEADER_SIGNATURE]: header }, null);
    expect(paid.status, paid.text).toBe(200);
    // The business does not wait for the node's batch: it calls settle_own with the voucher it was paid with, and the
    // node's acceptance of it from the receipt.
    const v = decodeHeader<any>(header).payload;
    const nodeReceipt = decodeHeader<any>(paid.headers.get(HEADER_RESPONSE)).receipts[0];
    await chain.settleOwn(
      SHOP.account,
      { budgetId: v.budgetId, payee: v.payee, amount: BigInt(v.amount), cumulative: BigInt(v.cumulative), requestHash: v.requestHash, signature: v.signature },
      { nodeKey: nodeReceipt.node, timestampS: BigInt(nodeReceipt.timestamp), signature: nodeReceipt.nodeSignature },
    );
    const out = (await call("POST", "/v1/settlements")).json;
    expect(out.sellerSettled).toEqual([expect.objectContaining({ budgetId: budget.id, payee: SHOP.account, amount: "1000000", calls: 1 })]);
    const proof = (await call("GET", `/v1/checkout/${paid.json.payment_id}/proof`, undefined, {}, null)).json;
    expect(proof.status).toBe("paid");
    // Honest about what exists: no batch, no transaction of this node, no Merkle proof to verify.
    expect(proof.credits).toEqual([expect.objectContaining({ method: "voucher", amount: "1000000", batch_id: null, tx_hash: null, verified: null })]);
    const receipt = await (await fetch(proof.credits[0].receipt_proof_url.replace("http://node.test", node.url))).json();
    expect(receipt).toMatchObject({ status: "settled", settledBy: "seller", proof: [], sellerSettlement: { covered: true } });
  });
});

describe("reconciliation report", () => {
  it("reports wallet and voucher payments with NEAR transactions, batches and receipt proofs, in JSON and CSV", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const r = await call("GET", `/v1/reports/reconciliation?from=${day}&to=${day}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ object: "reconciliation_report", network: chain.network, token: { address: chain.token, symbol: "USDC", decimals: 6 }, ledger: { matches: true } });
    const wallet = r.json.rows.find((x: { method: string; status: string }) => x.method === "wallet" && x.status === "paid");
    expect(wallet).toMatchObject({ amount_paid: "2.500000", refunded: "0.500000", payer: SHOPPER, transactions: [{ method: "wallet", tx_hash: "8vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx" }] });
    // A voucher payment settled in a batch (the one the business settled itself carries no batch).
    const voucher = r.json.rows.find((x: { method: string; status: string; batch_ids: string[] }) => x.method === "voucher" && x.status === "paid" && x.batch_ids.length > 0);
    expect(voucher.transactions[0]).toMatchObject({ method: "voucher", status: "confirmed", batch_id: expect.any(String), receipt_proof_url: expect.stringContaining("/v1/receipts/") });
    expect(r.json.totals.payments).toBe(r.json.rows.length);
    const csv = await call("GET", `/v1/reports/reconciliation?from=${day}&to=${day}&format=csv`);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.text.split("\r\n").filter(Boolean)).toHaveLength(r.json.rows.length + 2);
  });
});
