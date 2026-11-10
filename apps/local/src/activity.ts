/**
 * A little real activity, so every dashboard page has something true to show: paid agent calls through the SDK, two
 * refusals with different rules, one settled batch, one payout, one paid and one unpaid checkout payment, and a few
 * calls left unsettled for the person to settle themselves.
 *
 * Nothing is written to the database directly. Agents call the paid services; the owner's session settles and pays
 * out through the routes the dashboard buttons use; the shopper pays through the public checkout routes and the local
 * signer.
 */
import type { DemoHub } from "@payminto/demo";
import { formatAmount, type AccountId, type Id32, type WalletTx } from "@payminto/protocol";
import type { LocalAccounts } from "./accounts.ts";
import type { AgentDesk, CallResult } from "./agents.ts";
import type { RegisteredService, ServiceKey } from "./services.ts";
import { NodeSession } from "./session.ts";
import type { BudgetSeed, SetupResult, SignerClient } from "./setup.ts";

export type Refused = { budget: string; service: string; rule: string; message: string };
export type BatchInfo = { id: Id32; status: string; calls: number; transfers: number; gross: string; net: string; txHash: string | null };
export type CheckoutPayment = { id: string; status: string; amount: string; checkoutUrl: string; txHash: string | null };

export type ActivityResult = {
  paid: Array<{ budget: string; service: ServiceKey; callId: Id32; priceAtomic: string }>;
  refused: Refused[];
  batch: BatchInfo;
  payout: { seq: number; txHash: string; items: Array<{ account: AccountId; paid: string }> };
  paidCheckout: CheckoutPayment;
  unpaidCheckout: CheckoutPayment;
  /** Calls accepted after the batch, waiting for the person's own "settle now". */
  pending: number;
  /** A call that waits for the owner: the payee the check warned about, and the Budget that would pay it. */
  waitingApproval: { budgetId: Id32; payee: AccountId; rule: string };
};

/** "Approve this payee" as the Budget's page will send it: POST /v1/budgets/:id/payee-approvals. */
export async function approvePayee(owner: NodeSession, budgetId: Id32, payee: AccountId, note = "Approved from the local stack"): Promise<{ decision: string; signals: string[] | null }> {
  const out = await owner.post<{ approval: { decision: string; signals: string[] | null } }>(`/v1/budgets/${budgetId}/payee-approvals`, { payee, decision: "approve", note });
  return out.approval;
}

export type WaitingPayee = { payee: AccountId; amount: string; attempts: number; verdict: string | null; signals: Array<{ id: string; severity: string; reason: string }> };

/** What waits for the owner on one Budget, and what the owner already decided: GET /v1/budgets/:id/payee-approvals. */
export async function payeeApprovals(owner: NodeSession, budgetId: Id32): Promise<{ approvals: Array<{ payee: AccountId; decision: string }>; waiting: WaitingPayee[] }> {
  return owner.get(`/v1/budgets/${budgetId}/payee-approvals`);
}

const usdc = (atomic: bigint | string) => `${formatAmount(BigInt(atomic))} USDC`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CallOutcome = { budget: BudgetSeed; service: RegisteredService; result: CallResult };

/** One agent call from a seeded Budget to a registered service. */
export async function agentCall(desk: AgentDesk, budget: BudgetSeed, service: RegisteredService, guard = false): Promise<CallOutcome> {
  return { budget, service, result: await desk.call({ budgetId: budget.budgetId, agentPk: budget.agentPk, url: service.url, guard }) };
}

type BatchRow = { id: Id32; status: string; calls: number; transfers: number; gross: string; net: string; txHash: string | null };

/**
 * "Settle now" as the platform owner presses it: POST /v1/settlements. One press can make several batches, because a
 * batch clears one Budget per owner: an owner with two Budgets gets two. With nothing to settle the node says why.
 */
export async function settleNow(owner: NodeSession): Promise<{ batches: BatchInfo[]; skipped: string | null }> {
  const raw = await owner.post<{ batches?: BatchRow[]; skipped?: string }>("/v1/settlements");
  return { batches: (raw.batches ?? []).map((b) => ({ id: b.id, status: b.status, calls: b.calls, transfers: b.transfers, gross: b.gross, net: b.net, txHash: b.txHash })), skipped: raw.skipped ?? null };
}

export type PayoutItem = { account: AccountId; creditBefore: string; creditAfter: string | null; paid: string | null; outcome: string };
export type PayoutRun = { seq: number; status: string; txHash: string | null; error: string | null; items: PayoutItem[] };

/** "Pay out" as the platform owner presses it: POST /v1/payouts. With nothing due the node says so and sends nothing. */
export async function payOut(owner: NodeSession): Promise<{ payouts: PayoutRun[]; waitingRegistration: AccountId[]; skipped: string | null }> {
  const raw = await owner.post<{ payouts?: PayoutRun[]; waitingRegistration?: AccountId[]; skipped?: string }>("/v1/payouts");
  return { payouts: raw.payouts ?? [], waitingRegistration: raw.waitingRegistration ?? [], skipped: raw.skipped ?? null };
}

type CheckoutView = { id: string; status: string; amount_due: string; checkout_url?: string; wallet?: { transaction: WalletTx } | null; tx_hash?: string | null };

/** A new payment from a public payment link, as the hosted link page creates one. */
export async function paymentFromLink(nodeUrl: string, origin: string, slug: string): Promise<CheckoutView> {
  const anon = new NodeSession({ baseUrl: nodeUrl, origin });
  return anon.post<CheckoutView>(`/v1/links/public/${slug}/payments`, { method: "wallet" });
}

/**
 * Pays a checkout from a local account, as the hosted checkout page does: read the payment, sign the transaction the
 * node prepared with the local signer, tell the node it was sent, and wait until the node has read the hub's record.
 */
export async function payCheckout(o: { nodeUrl: string; origin: string; signer: SignerClient; payer: AccountId; paymentId: string }): Promise<CheckoutPayment> {
  const anon = new NodeSession({ baseUrl: o.nodeUrl, origin: o.origin });
  let view = await anon.get<CheckoutView>(`/v1/checkout/${o.paymentId}`);
  if (!view.wallet) view = await anon.post<CheckoutView>(`/v1/checkout/${o.paymentId}/method`, { method: "wallet" });
  if (!view.wallet) throw new Error(`payment ${o.paymentId} offers no wallet transaction`);
  const [sent] = await o.signer.signAndSend(o.payer, [view.wallet.transaction]);
  if (!sent?.ok) throw new Error(`the checkout transaction of ${o.paymentId} failed: ${JSON.stringify(sent?.outcome.status)}`);
  await anon.post(`/v1/checkout/${o.paymentId}/wallet`, { tx_hash: sent.hash });
  for (let i = 0; i < 40; i++) {
    view = await anon.get<CheckoutView>(`/v1/checkout/${o.paymentId}`);
    if (view.status === "paid" || view.status === "overpaid") break;
    await sleep(500);
  }
  return { id: view.id, status: view.status, amount: view.amount_due, checkoutUrl: view.checkout_url ?? `${o.origin}/pay/${view.id}`, txHash: sent.hash };
}

export async function runActivity(o: {
  urls: { node: string; dashboard: string };
  hub: DemoHub;
  accounts: LocalAccounts;
  setup: SetupResult;
  desk: AgentDesk;
  services: RegisteredService[];
  signer: SignerClient;
  say: (line: string) => void;
}): Promise<ActivityResult> {
  const { say, setup, desk } = o;
  const svc = Object.fromEntries(o.services.map((s) => [s.key, s])) as Record<ServiceKey, RegisteredService>;
  const { alice, bob } = setup.budgets;
  const paid: ActivityResult["paid"] = [];
  const refused: Refused[] = [];
  const run = async (budget: BudgetSeed, key: ServiceKey, times: number) => {
    for (let i = 0; i < times; i++) {
      const { result } = await agentCall(desk, budget, svc[key]);
      if (result.ok) paid.push({ budget: budget.label, service: key, callId: result.callId, priceAtomic: result.priceAtomic });
      else if (result.refused) refused.push({ budget: budget.label, service: svc[key].name, rule: result.rule, message: result.message });
      else throw new Error(`${budget.label} calling ${svc[key].name}: ${result.message}`);
    }
  };

  // Alice's agent buys from Bob and the seller; Bob's agent buys from Alice and the seller. They owe each other.
  await Promise.all([run(alice, "quotes", 6).then(() => run(alice, "scan", 2)), run(bob, "briefs", 1).then(() => run(bob, "scan", 1))]);
  say(`   ${paid.length} paid agent calls over HTTP 402: the research agent bought 6 quotes and 2 scans, the trading agent 1 brief and 1 scan.`);

  // Two refusals, each by a different rule. The agent's own guard is off here, so the node is what refuses and records.
  await run(alice, "report", 1);
  await run(alice, "alpha", 1);
  for (const r of refused) say(`   Refused by the node: ${r.budget} calling ${r.service}: ${r.rule}.`);
  if (new Set(refused.map((r) => r.rule)).size < 2) throw new Error(`expected two refusals with different rules, got ${JSON.stringify(refused)}`);

  // One call that waits. The new vendor is on the Budget's payee list, but its account never registered with the
  // token, so the node's payee check warns and the call is not paid until the owner approves the payee.
  const asked = refused.length;
  await run(alice, "vendor", 1);
  const waiting = refused[asked];
  if (!waiting || waiting.rule !== "PAYEE_NEEDS_APPROVAL") throw new Error(`expected the call to the new vendor to wait for approval, got ${JSON.stringify(waiting ?? paid.at(-1))}`);
  say(`   Waiting for the owner: ${waiting.budget} calling ${waiting.service}: ${waiting.rule} (${o.accounts.vendor} is not registered with the token).`);
  const before = paid.length;

  // One batch, settled by the platform owner's "Settle now".
  const settled = await settleNow(setup.owner);
  const batch = settled.batches[0];
  if (settled.batches.length !== 1 || !batch || batch.status !== "confirmed") throw new Error(`expected one confirmed batch, got ${JSON.stringify(settled)}`);
  say(`   Settled batch ${batch.id.slice(0, 8)}...: ${batch.calls} calls, ${usdc(batch.gross)} cleared, ${usdc(batch.net)} moved in ${batch.transfers} transfer(s), tx ${batch.txHash}.`);

  // One payout of hub credit to the creditors' own accounts.
  const out = await payOut(setup.owner);
  const run1 = out.payouts[0];
  if (!run1 || run1.status !== "confirmed" || !run1.txHash) throw new Error(`the payout did not confirm: ${JSON.stringify(out)}`);
  const payout = { seq: run1.seq, txHash: run1.txHash, items: run1.items.map((i) => ({ account: i.account, paid: i.paid ?? "0" })) };
  say(`   Payout ${payout.seq}: ${payout.items.map((i) => `${usdc(i.paid)} to ${i.account}`).join(", ")}, tx ${payout.txHash}.`);

  // Checkout: the shopper pays one payment from the link; a second one is left open.
  const first = await paymentFromLink(o.urls.node, o.urls.dashboard, setup.link.slug);
  const paidCheckout = await payCheckout({ nodeUrl: o.urls.node, origin: o.urls.dashboard, signer: o.signer, payer: o.accounts.by.shopper.accountId, paymentId: first.id });
  if (paidCheckout.status !== "paid") throw new Error(`the checkout payment ${first.id} is ${paidCheckout.status}, not paid`);
  say(`   Checkout payment ${paidCheckout.id} paid by ${o.accounts.by.shopper.accountId}: ${usdc(paidCheckout.amount)}, tx ${paidCheckout.txHash}.`);
  // The second payment is created the way a business's own server creates one: the SDK's GatewayClient with its API key.
  const second = await setup.gateway.payments.create({ amount: (12n * 1_000_000n).toString(), method: "wallet", description: "Espresso subscription, 1 month", reference: "order-1002", expires_in: 86_400 });
  const unpaidCheckout: CheckoutPayment = { id: second.id, status: second.status, amount: second.amount_due, checkoutUrl: second.checkout_url, txHash: null };
  say(`   Checkout payment ${unpaidCheckout.id} created with the business API key and left unpaid (${unpaidCheckout.status}): ${unpaidCheckout.checkoutUrl}`);

  // A few calls left unsettled, so "Next settlement" has something to settle.
  await Promise.all([run(alice, "quotes", 2), run(bob, "briefs", 1)]);
  const pending = paid.length - before;
  say(`   ${pending} more paid calls left unsettled, for you to settle from the dashboard.`);

  return { paid, refused, batch, payout, paidCheckout, unpaidCheckout, pending, waitingApproval: { budgetId: alice.budgetId, payee: o.accounts.vendor, rule: waiting.rule } };
}
