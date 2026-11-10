/**
 * `pnpm local --check`: the walkthrough of the printed guide, done by a script.
 *
 * Every step goes the way the browser goes: the node's API through the dashboard's own `/api` path with a signed-in
 * session, the local signer over HTTP with the dashboard's origin, the public checkout routes, and the agent remote's
 * own route for agent calls. Every result is then asserted against the chain, read through a client that holds no key
 * (`NearRpcChain` without an operator key, and the browser's `NearReader` for the receipt proof), never against the
 * node's database.
 */
import { readFileSync, statSync } from "node:fs";
import {
  checkReceiptOnChain,
  depositBudgetTx,
  formatAmount,
  maxSettleBatchStorageCost,
  nep413Digest,
  NearReader,
  revokeBudgetTx,
  signatureHex,
  verifyDigest,
  type AccountId,
  type Chain,
  type ClearingReceipt,
  type Id32,
  type PublicKey,
  type WalletTx,
} from "@payminto/protocol";
import { OwnerClient, verifyReceiptOnchain } from "@payminto/sdk";
import { nearBalance, USDC } from "./accounts.ts";
import { approvePayee, payCheckout, payeeApprovals, payOut, paymentFromLink, settleNow } from "./activity.ts";
import type { CallResult } from "./agents.ts";
import { NETWORK } from "./config.ts";
import { NodeSession } from "./session.ts";
import { MERCHANT_EMAIL, OWNER_EMAIL, POLICIES, signerClient } from "./setup.ts";
import type { Stack } from "./stack.ts";

export type Check = { name: string; ok: boolean; detail: string };

const usdc = (a: bigint | string) => `${formatAmount(BigInt(a))} USDC`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `read` satisfies `done` or the deadline passes; returns the last value either way. */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await read();
  while (!done(v) && Date.now() < deadline) {
    await sleep(everyMs);
    v = await read();
  }
  return v;
}

type RemoteState = { budgets: Array<{ id: Id32; label: string; agentKey: PublicKey }>; spareKeys: Array<{ name: string; publicKey: PublicKey }>; services: Array<{ id: string; key: string; name: string }> };
type ProofJson = { receipt: ClearingReceipt; batchId: Id32 | null; proof: Id32[] };
type CallRow = { id: Id32; status: string };
type DenialRow = { rule?: string; code?: string; budgetId?: Id32; attemptedAmount?: string; amount?: string };

export async function runChecks(s: Stack, say: (line: string) => void): Promise<Check[]> {
  const checks: Check[] = [];
  const chain: Chain = s.hub.chain;
  const { hub, token } = s.hub.names;
  const acct = (k: keyof typeof s.accounts.by): AccountId => s.accounts.by[k].accountId;
  /** Runs one step. A thrown error fails the step and the pass goes on, so one failure does not hide the next. */
  const step = async (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      const r = await run();
      checks.push({ name, ...r });
    } catch (err) {
      checks.push({ name, ok: false, detail: `threw: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
    }
    const c = checks.at(-1)!;
    say(`   ${c.ok ? "ok  " : "FAIL"} ${c.name}`);
  };

  // The browser's own routes: the dashboard's /api path in front of the node, and the signer with the dashboard's origin.
  const api = s.dashboard ? `${s.urls.dashboard}/api` : s.urls.node;
  const origin = s.urls.dashboard;
  const signer = signerClient(s.urls.signer, s.signerToken, origin);
  const owner = new NodeSession({ baseUrl: api, origin });
  const ownerLogin = s.setup.logins.find((l) => l.email === OWNER_EMAIL)!;
  const adminLogin = s.setup.logins.find((l) => l.email === MERCHANT_EMAIL)!;
  const remote = async (): Promise<RemoteState> => (await fetch(`${s.urls.services}/remote/state`)).json() as Promise<RemoteState>;
  const call = async (budgetId: Id32, serviceKey: string, guard = false): Promise<CallResult> => {
    const state = await remote();
    const service = state.services.find((x) => x.key === serviceKey)!;
    const res = await fetch(`${s.urls.services}/remote/call`, { method: "POST", headers: { "content-type": "application/json", origin: s.urls.services }, body: JSON.stringify({ budgetId, serviceId: service.id, guard }) });
    return (await res.json()) as CallResult;
  };
  const { alice, bob } = s.setup.budgets;

  say("");
  say("Scripted pass: the steps of the guide, through the routes the browser uses, each checked on chain.");

  await step("the hub is locked and runs the committed hub.wasm", async () => {
    const f = await s.hub.facts();
    return { ok: !!f && f.accessKeys === 0 && f.codeHash === f.expectedCodeHash, detail: f ? `${hub} has ${f.accessKeys} access keys and code hash ${f.codeHash}` : "no hub facts" };
  });

  await step("the node is ready on the hub: its receipt key is registered, its storage is prepaid, and it reported no readiness problem", async () => {
    const [keys, storage] = await Promise.all([chain.receiptKeys(s.accounts.settler), chain.storageOf(s.accounts.settler)]);
    // The settler pays only for its own batch records: owners prepay their payees' settlement storage.
    const need = maxSettleBatchStorageCost(100);
    const reported = readFileSync(s.paths.nodeLog, "utf8").split("\n").filter((l) => l.includes("hub readiness")).length;
    const near = (y: bigint) => `${(Number(y / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;
    return { ok: keys.includes(s.nodeKey) && storage >= need && reported === 0, detail: `the hub holds receipt key ${keys.join(", ") || "none"} for ${s.accounts.settler}, which is the node's; prepaid storage ${near(storage)}, the records of 100 batches cost ${near(need)}; ${reported} readiness problems in the node's log` };
  });

  await step("the signer refuses a wrong token, a foreign origin, another network and anything but a function call", async () => {
    const post = (headers: Record<string, string>, body: unknown) => fetch(`${s.urls.signer}/v1/sign-and-send`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => r.status);
    const auth = { authorization: `Bearer ${s.signerToken}` };
    const tx = depositBudgetTx(token, hub, alice.budgetId, 1n);
    const wrongToken = await post({ authorization: "Bearer not-the-token" }, { network: NETWORK, accountId: acct("alice"), transactions: [tx] });
    const foreign = await post({ ...auth, origin: "https://example.com" }, { network: NETWORK, accountId: acct("alice"), transactions: [tx] });
    const testnet = await post(auth, { network: "near:testnet", accountId: acct("alice"), transactions: [tx] });
    const mainnet = await post(auth, { network: "near:mainnet", accountId: acct("alice"), transactions: [tx] });
    const transfer = await post(auth, { network: NETWORK, accountId: acct("alice"), transactions: [{ receiverId: acct("bob"), actions: [{ type: "Transfer", params: { deposit: "1" } }] }] });
    const stranger = await post(auth, { network: NETWORK, accountId: s.accounts.settler, transactions: [tx] });
    const got = [wrongToken, foreign, testnet, mainnet, transfer, stranger];
    return { ok: got.join() === [401, 403, 403, 403, 400, 404].join(), detail: `HTTP ${got.join(", ")} for a wrong token, a foreign origin, near:testnet, near:mainnet, a plain transfer and the node's own account` };
  });

  await step("sign in as the platform owner and as the business admin", async () => {
    await owner.login(ownerLogin.email, ownerLogin.password);
    const me = await owner.get<{ user?: { email?: string; platform_role?: string | null } }>("/v1/auth/session");
    const admin = new NodeSession({ baseUrl: api, origin });
    await admin.login(adminLogin.email, adminLogin.password);
    const business = await admin.get<{ name?: string; payout?: string }>("/v1/merchant");
    return { ok: me.user?.email === OWNER_EMAIL && me.user.platform_role === "owner" && business.payout === acct("merchant"), detail: `${me.user?.email} is platform ${me.user?.platform_role}; ${adminLogin.email} sees ${business.name} with payout ${business.payout}; through ${api}` };
  });

  await step("setup left a business, a payment link, six paid services and three funded Budgets, and the hub holds all three", async () => {
    const [merchants, links, providers, budgets] = await Promise.all([
      owner.get<{ items: unknown[] }>("/v1/merchants"),
      owner.get<{ items: unknown[] }>("/v1/links"),
      fetch(`${api}/v1/providers`).then((r) => r.json() as Promise<Array<{ name: string }>>),
      owner.get<Array<{ id: Id32 }>>("/v1/budgets"),
    ]);
    const onChain = await Promise.all([chain.budget(alice.budgetId), chain.budget(bob.budgetId), chain.budget(s.setup.budgets.carol.budgetId)]);
    const ok = merchants.items.length === 1 && links.items.length === 1 && providers.filter((p) => s.services.some((x) => x.name === p.name)).length === 6 && budgets.length === 3 && onChain.every((b) => b !== null && b.settler === s.accounts.settler && b.escrow > 0n);
    return { ok, detail: `${merchants.items.length} business, ${links.items.length} link, ${providers.length} services, ${budgets.length} Budgets; on the hub: ${onChain.map((b) => (b ? `${b.owner} cap ${usdc(b.cap)} escrow ${usdc(b.escrow)}` : "missing")).join("; ")}` };
  });

  await step("fund a Budget from a local account: escrow rises on the hub by exactly the deposit", async () => {
    const before = (await chain.budget(alice.budgetId))!.escrow;
    const wallet = await chain.balanceOf(acct("alice"));
    const [sent] = await signer.signAndSend(acct("alice"), [depositBudgetTx(token, hub, alice.budgetId, 2n * USDC)]);
    const after = (await chain.budget(alice.budgetId))!.escrow;
    const walletAfter = await chain.balanceOf(acct("alice"));
    const seen = await until(
      () => owner.get<{ escrow: string | null }>(`/v1/budgets/${alice.budgetId}`),
      (b) => b.escrow === after.toString(),
    );
    return { ok: !!sent?.ok && after - before === 2n * USDC && wallet - walletAfter === 2n * USDC && seen.escrow === after.toString(), detail: `${acct("alice")} deposited 2.00 USDC in tx ${sent?.hash}: hub escrow ${usdc(before)} to ${usdc(after)}, and the node shows ${seen.escrow === null ? "nothing yet" : usdc(seen.escrow)}` };
  });

  let extraBudget: Id32 | null = null;
  await step("open a new Budget as its owner and register it: the hub stores the terms and the agent remote can pay from it", async () => {
    const spare = (await remote()).spareKeys[0]!;
    const client = new OwnerClient({ nodeUrl: api, network: NETWORK, hub, token, owner: acct("bob"), settler: s.accounts.settler, fetch: owner.fetch });
    const policy = { ...POLICIES.bob, purpose: "A Budget opened during the scripted check" };
    const { terms, budgetId } = client.createBudget({ agentPk: spare.publicKey, cap: 3n * USDC, validForSeconds: 86_400, payees: [acct("alice"), acct("seller")], policy });
    const sent = await signer.signAndSend(acct("bob"), [client.openTx(terms), client.depositTx(budgetId, 1n * USDC)]);
    await client.submit({ terms, policy, label: "Checked agent" });
    extraBudget = budgetId;
    const b = await chain.budget(budgetId);
    const listed = (await remote()).budgets.some((x) => x.id === budgetId);
    const r = await call(budgetId, "scan");
    return { ok: sent.length === 2 && sent.every((x) => x.ok) && b?.owner === acct("bob") && b.cap === 3n * USDC && b.escrow === 1n * USDC && b.agentPk === spare.publicKey && listed && r.ok, detail: `Budget ${budgetId.slice(0, 8)}... on the hub: owner ${b?.owner}, cap ${b ? usdc(b.cap) : "?"}, escrow ${b ? usdc(b.escrow) : "?"}; its first call was ${r.ok ? `paid, ${usdc(r.priceAtomic)}` : "not paid"}` };
  });

  let paidCall: Id32 | null = null;
  await step("an agent call is paid and shows up in the node's calls", async () => {
    const r = await call(alice.budgetId, "quotes");
    if (!r.ok) return { ok: false, detail: `the call was not paid: ${JSON.stringify(r).slice(0, 200)}` };
    paidCall = r.callId;
    const calls = await owner.get<{ items: CallRow[] }>(`/v1/calls?budgetId=${alice.budgetId}&limit=5`);
    const row = calls.items.find((c) => c.id === r.callId);
    return { ok: !!row && r.priceAtomic === "2000", detail: `Research agent paid ${usdc(r.priceAtomic)} to ${acct("bob")}, call ${r.callId.slice(0, 8)}... is ${row?.status ?? "missing"} at the node` };
  });

  await step("live updates reach the browser: a paid call arrives on the event stream through the dashboard, unbuffered", async () => {
    // What Live Calls reads. A proxy that compresses the stream (the dashboard's Next.js server does, unless the node
    // marks it no-transform) holds every event back, and the page never updates.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await owner.fetch(`${api}/v1/events`, { headers: { accept: "text/event-stream" }, signal: ctl.signal });
      if (!res.ok || !res.body) return { ok: false, detail: `HTTP ${res.status} from ${api}/v1/events` };
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      while (!text.includes("event: ready")) text += (await reader.read()).value ?? "";
      const r = await call(alice.budgetId, "quotes");
      if (!r.ok) return { ok: false, detail: `the call was not paid: ${JSON.stringify(r).slice(0, 200)}` };
      const started = Date.now();
      while (!text.includes(r.callId)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += value;
      }
      const ms = Date.now() - started;
      await reader.cancel();
      const arrived = text.includes("event: call.accepted") && text.includes(r.callId);
      return { ok: arrived, detail: arrived ? `call ${r.callId.slice(0, 8)}... arrived as call.accepted ${ms} ms after it was paid; cache-control ${res.headers.get("cache-control")}` : "the stream ended without the call" };
    } catch (err) {
      return { ok: false, detail: ctl.signal.aborted ? "no event within 15 s: the stream is being held back" : String(err) };
    } finally {
      clearTimeout(timer);
    }
  });

  await step("two refusals name their rules, are recorded by the node, and leave the agent's position unchanged", async () => {
    const position = () => fetch(`${api}/v1/budgets/${alice.budgetId}/position?payee=${acct("seller")}`).then((r) => r.json() as Promise<{ cumulative: string }>);
    const before = await position();
    const overCap = await call(alice.budgetId, "report");
    const unlisted = await call(alice.budgetId, "alpha");
    const guarded = await call(alice.budgetId, "report", true);
    const after = await position();
    const denials = await owner.get<DenialRow[]>("/v1/denials?limit=20");
    const rules = denials.map((d) => d.rule ?? d.code);
    const rule = (r: CallResult) => (!r.ok && r.refused ? `${r.rule} by the ${r.by}` : "not refused");
    const ok = rule(overCap) === "PER_CALL_CAP by the node" && rule(unlisted) === "PAYEE_NOT_ALLOWED by the node" && rule(guarded) === "PER_CALL_CAP by the agent" && before.cumulative === after.cumulative && rules.includes("PER_CALL_CAP") && rules.includes("PAYEE_NOT_ALLOWED");
    return { ok, detail: `Deep Report: ${rule(overCap)}; Unlisted Alpha: ${rule(unlisted)}; with the SDK guard on: ${rule(guarded)}; position with ${acct("seller")} stayed ${usdc(after.cumulative)}` };
  });

  await step("a payee the check warns about waits for the owner: refused until approved, and paid on the next call", async () => {
    const vendor = s.accounts.vendor;
    // The warning is about a fact on chain: the account exists and is not registered with the token.
    const registered = await chain.isRegistered(vendor);
    const first = await call(alice.budgetId, "vendor");
    const waiting = (await payeeApprovals(owner, alice.budgetId)).waiting.find((w) => w.payee === vendor);
    const signals = waiting?.signals.filter((x) => x.severity === "warn").map((x) => x.id) ?? [];
    // The owner decides. The Budget page will send this; until that screen exists, this is the node's own route.
    const approval = await approvePayee(owner, alice.budgetId, vendor, "Approved in the scripted check");
    const second = await call(alice.budgetId, "vendor");
    const after = await payeeApprovals(owner, alice.budgetId);
    const rule = !first.ok && first.refused ? `${first.rule} by the ${first.by}` : first.ok ? "paid" : "not refused";
    const ok = !registered && rule === "PAYEE_NEEDS_APPROVAL by the node" && signals.includes("token_unregistered") && approval.decision === "approve" && second.ok && after.approvals.some((a) => a.payee === vendor && a.decision === "approve") && !after.waiting.some((w) => w.payee === vendor);
    return { ok, detail: `${vendor} is ${registered ? "registered" : "not registered"} with the token; the first call: ${rule}, waiting with ${signals.join(", ") || "no warning"} after ${waiting?.attempts ?? 0} attempt(s); the owner approved; the next call: ${second.ok ? `paid ${usdc(second.priceAtomic)}` : "not paid"}` };
  });

  let settled = false;
  await step("settle now: the hub stores every batch with the node's gross and net, and less moves than was cleared", async () => {
    // Both owners owe each other, so there is something to offset.
    await call(bob.budgetId, "briefs");
    const out = await settleNow(owner);
    if (out.batches.length === 0 || out.batches.some((x) => x.status !== "confirmed")) return { ok: false, detail: `no confirmed batch: ${JSON.stringify(out).slice(0, 300)}` };
    settled = true;
    // One press can make more than one batch: a batch clears one Budget per owner, and Bob now owns two.
    const rows = await Promise.all(out.batches.map(async (x) => ({ x, onChain: await chain.batch(x.id, s.accounts.settler), tx: x.txHash ? await chain.txState(x.txHash) : null })));
    const same = rows.every((r) => r.onChain !== null && r.onChain.settler === s.accounts.settler && r.onChain.gross === BigInt(r.x.gross) && r.onChain.net === BigInt(r.x.net) && r.tx?.status === "final");
    const gross = rows.reduce((n, r) => n + (r.onChain?.gross ?? 0n), 0n);
    const net = rows.reduce((n, r) => n + (r.onChain?.net ?? 0n), 0n);
    const calls = out.batches.reduce((n, x) => n + x.calls, 0);
    const transfers = out.batches.reduce((n, x) => n + x.transfers, 0);
    return { ok: same && net < gross && transfers < calls, detail: `${out.batches.length} batch(es) ${out.batches.map((x) => `${x.id.slice(0, 8)}...`).join(", ")}: ${calls} calls, ${usdc(gross)} gross cleared, ${usdc(net)} moved in ${transfers} transfer(s); the hub stores the same gross and net for each, settled by ${s.accounts.settler}; tx ${out.batches.map((x) => x.txHash).join(", ")} final` };
  });

  await step("a call's proof verifies against the local chain, as the dashboard's receipt page does, and a changed amount does not", async () => {
    if (!paidCall || !settled) return { ok: false, detail: "no settled call to prove" };
    const p = await owner.get<ProofJson>(`/v1/receipts/${paidCall}/proof`);
    if (!p.batchId) return { ok: false, detail: "the call is in no batch" };
    const r = p.receipt;
    const fields = { callId: r.callId, budgetId: r.budgetId, payee: r.payee, amount: BigInt(r.amount), cumulative: BigInt(r.cumulative), requestHash: r.requestHash, timestampMs: BigInt(r.timestamp) * 1000n, voucherSig: r.voucherSig };
    // The browser's reader: plain fetch JSON-RPC at final finality against the RPC the node reports for the sandbox.
    const info = await fetch(`${api}/v1/info`).then((x) => x.json() as Promise<{ network: { rpc_url: string } }>);
    const reader = new NearReader({ rpcUrl: info.network.rpc_url, hub, timeoutMs: 8_000 });
    const good = await checkReceiptOnChain(reader, { network: NETWORK, batchId: p.batchId, settler: s.accounts.settler, fields, proof: p.proof });
    const bad = await checkReceiptOnChain(reader, { network: NETWORK, batchId: p.batchId, settler: s.accounts.settler, fields: { ...fields, amount: fields.amount + 1n }, proof: p.proof });
    const sdk = await verifyReceiptOnchain({ chain, operator: s.accounts.settler, nodeKey: s.nodeKey, receipt: r, batchId: p.batchId, proof: p.proof, agentPk: alice.agentPk });
    return { ok: good.verified && good.rootMatches && good.hubVerified === true && !bad.verified && sdk.verified && info.network.rpc_url === s.urls.rpc, detail: `read from ${good.rpcUrl} at final block ${good.blockHeight}: root ${good.storedRoot?.slice(0, 8)}... equals the recomputed root, verify_receipt agrees; with the amount raised by one: ${bad.verified ? "VERIFIED (wrong)" : "not verified"}; SDK verifier: ${sdk.verified ? "verified" : sdk.reason}` };
  });

  let checkoutMerchantCredit = 0n;
  await step("the shopper pays a checkout link: the hub records the payment for the merchant", async () => {
    const before = await chain.balanceOf(acct("shopper"));
    const view = await paymentFromLink(api, origin, s.setup.link.slug);
    const paid = await payCheckout({ nodeUrl: api, origin, signer, payer: acct("shopper"), paymentId: view.id });
    const checkoutId = (await fetch(`${api}/v1/checkout/${view.id}`).then((r) => r.json() as Promise<{ checkout_id: Id32 }>)).checkout_id;
    const [record] = await chain.payments([checkoutId]);
    const after = await chain.balanceOf(acct("shopper"));
    checkoutMerchantCredit = await chain.creditOf(acct("merchant"));
    const amount = BigInt(s.setup.link.amount);
    const ok = paid.status === "paid" && !!record && record.merchant === acct("merchant") && record.payer === acct("shopper") && record.amount === amount && before - after === amount && checkoutMerchantCredit >= amount;
    return { ok, detail: `${view.id} is ${paid.status}; the hub records ${record ? `${usdc(record.amount)} from ${record.payer} for ${record.merchant}` : "nothing"}; the shopper's balance fell by ${usdc(before - after)}; tx ${paid.txHash}` };
  });

  await step("pay out: hub credit leaves the hub and arrives in each creditor's own account", async () => {
    const who = [acct("merchant"), acct("seller"), acct("alice"), acct("bob")];
    const before = await Promise.all(who.map(async (a) => ({ a, credit: await chain.creditOf(a), balance: await chain.balanceOf(a) })));
    const out = await payOut(owner);
    const run = out.payouts[0];
    const after = await Promise.all(who.map(async (a) => ({ credit: await chain.creditOf(a), balance: await chain.balanceOf(a) })));
    const moved = before.map((b, i) => ({ a: b.a, credit: b.credit, arrived: after[i]!.balance - b.balance, left: after[i]!.credit }));
    const due = moved.filter((m) => m.credit > 0n);
    // The new vendor earned hub credit in the batch and is not registered with the token: its credit must stay on the hub.
    const vendorCredit = await chain.creditOf(s.accounts.vendor);
    const vendorWaits = out.waitingRegistration.includes(s.accounts.vendor) && vendorCredit > 0n && (await chain.balanceOf(s.accounts.vendor).catch(() => 0n)) === 0n;
    const ok = !!run && run.status === "confirmed" && due.length > 0 && due.some((m) => m.a === acct("merchant")) && moved.every((m) => m.arrived === m.credit && m.left === 0n) && vendorWaits;
    return { ok, detail: `payout ${run?.seq ?? "none"} (${run?.status ?? out.skipped}), tx ${run?.txHash}: ${due.map((m) => `${usdc(m.arrived)} to ${m.a}`).join(", ")}; hub credit left for them: ${usdc(moved.reduce((n, m) => n + m.left, 0n))}; ${s.accounts.vendor} keeps ${usdc(vendorCredit)} on the hub until it registers with the token` };
  });

  await step("revoke a Budget from its owner's account: the hub marks it revoked and the node refuses its next call", async () => {
    const [sent] = await signer.signAndSend(acct("bob"), [revokeBudgetTx(hub, bob.budgetId)]);
    const onChain = await chain.budget(bob.budgetId);
    const refused = await until(
      () => call(bob.budgetId, "scan"),
      (r) => !r.ok && r.refused && r.rule === "BUDGET_REVOKED",
      25_000,
      1_500,
    );
    const rule = !refused.ok && refused.refused ? refused.rule : "not refused";
    return { ok: !!sent?.ok && onChain?.revokedAt != null && rule === "BUDGET_REVOKED", detail: `${acct("bob")} revoked ${bob.budgetId.slice(0, 8)}... in tx ${sent?.hash}; the hub has revoked_at ${onChain?.revokedAt}; the next call was refused with ${rule}` };
  });

  await step("a NEP-413 message signed by the signer verifies against the account's key", async () => {
    const nonce = new Uint8Array(32).fill(7);
    const message = "Payminto local check";
    const m = await signer.signMessage(acct("merchant"), message, hub, nonce);
    const sig = signatureHex(m.signature);
    const ok = m.publicKey === s.accounts.by.merchant.publicKey && sig !== null && verifyDigest(m.publicKey as PublicKey, nep413Digest({ message, recipient: hub, nonce }), sig);
    return { ok, detail: `${acct("merchant")} signed "${message}" for ${hub}; the signature ${ok ? "verifies" : "does not verify"} against ${m.publicKey}` };
  });

  await step("revoke without gas: the relayer pays for an owner who cannot, and the owner's NEAR balance does not change", async () => {
    const carol = s.setup.budgets.carol;
    const info = await fetch(`${s.urls.relayer}/info`).then((r) => r.json() as Promise<{ relayer: string; hub: string; network: string; methods: string[] }>);
    const tx: WalletTx = revokeBudgetTx(hub, carol.budgetId);
    // Carol tries with her own gas first, as the dashboard's "Revoke on NEAR" would: the chain turns the transaction away.
    const own = await signer.signAndSend(acct("carol"), [tx]).then(
      () => "was accepted",
      (err: Error) => (/NOT_ENOUGH_NEAR/.test(err.message) ? "NOT_ENOUGH_NEAR" : err.message.slice(0, 120)),
    );
    const before = await nearBalance(s.urls.rpc, acct("carol"));
    const relayerBefore = await nearBalance(s.urls.rpc, s.accounts.relayer.accountId);
    // She signs the same call as a NEP-366 delegate with the local signer, and the page posts it to the relayer.
    const signed = await fetch(`${s.urls.signer}/v1/sign-delegate`, { method: "POST", headers: { authorization: `Bearer ${s.signerToken}`, "content-type": "application/json", origin }, body: JSON.stringify({ network: NETWORK, accountId: acct("carol"), transaction: tx }) });
    const d = (await signed.json()) as { signedDelegate: string };
    const post = () => fetch(`${s.urls.relayer}/relay`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ signedDelegate: d.signedDelegate }) });
    const relayed = await post();
    const answer = (await relayed.json()) as { txHash?: string; sender?: string; receiver?: string; methods?: string[]; error?: { code: string; message: string } };
    const again = await post();
    const againCode = ((await again.json()) as { error?: { code?: string } }).error?.code;
    const onChain = await chain.budget(carol.budgetId);
    const after = await nearBalance(s.urls.rpc, acct("carol"));
    const relayerAfter = await nearBalance(s.urls.rpc, s.accounts.relayer.accountId);
    const ok =
      info.hub === hub &&
      info.network === NETWORK &&
      info.relayer === s.accounts.relayer.accountId &&
      info.methods.includes("revoke_budget") &&
      own === "NOT_ENOUGH_NEAR" &&
      signed.ok &&
      relayed.status === 200 &&
      answer.sender === acct("carol") &&
      answer.receiver === hub &&
      onChain?.revokedAt != null &&
      after === before &&
      relayerAfter < relayerBefore &&
      again.status === 409 &&
      againCode === "NONCE_USED";
    return {
      ok,
      detail: `GET /info names ${info.hub} on ${info.network}; ${acct("carol")} holds ${before} yoctoNEAR and her own revoke was refused with ${own}; the relayer answered ${relayed.status}${answer.error ? ` ${answer.error.code}` : ""}, tx ${answer.txHash}; the hub has revoked_at ${onChain?.revokedAt}; her balance changed by ${after - before} yoctoNEAR and ${info.relayer} paid ${relayerBefore - relayerAfter}; the same delegate again: ${again.status} ${againCode}`,
    };
  });

  await step("the hub is solvent: its token balance equals escrow plus credits plus payouts in flight", async () => {
    await s.hub.solvency();
    return { ok: true, detail: `${hub} holds ${usdc(await chain.balanceOf(hub))}` };
  });

  if (s.dashboard) {
    await step("the dashboard serves the pages of the walkthrough", async () => {
      const paths = ["/login", "/", "/budgets", `/budgets/${alice.budgetId}`, "/netting", "/batches", "/payouts", "/blocked", `/receipts/${paidCall ?? ""}`, `/l/${s.setup.link.slug}`];
      const got = await Promise.all(paths.map(async (p) => ({ p, status: (await fetch(`${s.urls.dashboard}${p}`, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(120_000) })).status })));
      const bad = got.filter((g) => g.status !== 200);
      return { ok: bad.length === 0, detail: bad.length ? `not 200: ${bad.map((b) => `${b.p} ${b.status}`).join(", ")}` : `${got.length} pages answered 200 from ${s.urls.dashboard}` };
    });
  }

  await step("data safety: the database is a guarded *.demo.db, the logins file is private, and no log holds key material", async () => {
    const mode = statSync(s.paths.logins).mode & 0o777;
    const logs = [s.paths.nodeLog, s.paths.signerLog, s.paths.relayerLog, s.paths.sandboxLog, ...(s.dashboard ? [s.paths.dashboardLog] : [])].map((p) => readFileSync(p, "utf8")).join("\n");
    const secrets = [...s.accounts.list.map((a) => a.secretKey.slice("ed25519:".length)), s.accounts.relayer.secretKey.slice("ed25519:".length), ...s.setup.logins.map((l) => l.password), s.signerToken];
    const leaked = secrets.filter((x) => logs.includes(x)).length;
    const signed = readFileSync(s.paths.signerLog, "utf8").split("\n").filter((l) => /signed (transaction|message|delegate) account=\S+ receiver=\S+ methods=\S+/.test(l)).length;
    return { ok: s.paths.db.endsWith(".demo.db") && mode === 0o600 && leaked === 0 && signed >= 8, detail: `${s.paths.db.split("/").pop()} passes the node's reset guard; logins file mode ${mode.toString(8)}; ${leaked} of ${secrets.length} secrets found in the logs; ${signed} signer log lines, one per signature` };
  });

  return checks;
}
