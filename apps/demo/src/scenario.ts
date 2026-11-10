import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceDigest,
  ChainError,
  formatAmount,
  refusalSignedBy,
  signAcceptance,
  signDigest,
  STORAGE_BYTE_COST,
  voucherDigest,
  type Acceptance,
  type AccountId,
  type Claim,
  type ClearingReceipt,
  type Id32,
  type Keypair,
  type RefusalRecord,
  type Sig64,
} from "@payminto/protocol";
import { computeRequestHash, exportVouchers, FileVoucherStore, parseVoucherExport, settleOwnClaims, verifyReceiptOnchain, type AgentClient, type DeniedEvent } from "@payminto/sdk";
import type { HubFacts } from "./chain.ts";
import { OWNER_KEYS, type Owner } from "./names.ts";
import { PRICES, SWARM_SIZE, type Stack } from "./stack.ts";
import { receiptFile, receiptFileSchema, verifyReceipt, type ReceiptFile } from "./verify.ts";
import { runVerifierCli } from "./verify-cli-runner.ts";

export type Say = (line: string) => void;

export type RetryHintSeen = { kind: string; [k: string]: unknown };

/** One refusal as an agent surfaced it: the rule that fired, who enforced it, and what the agent may do next. */
export type RefusalSeen = {
  act: string;
  agent: string;
  rule: string;
  enforcedBy: "agent" | "node";
  attemptedAmount: string | null;
  remainingBudget: string | null;
  retry: RetryHintSeen | null;
};

/**
 * What the checks read. Chain facts (Budgets, batches, credits, balances, proofs, solvency) are read from the hub
 * through the keyless read side, never from the node's database. Calls and refusals are what the agents saw over HTTP.
 */
export type Report = {
  label: string;
  simulated: boolean;
  owners: Array<{ who: Owner; account: AccountId; budgetId: Id32; ownerOnChain: AccountId | null }>;
  paidCalls: number;
  refusals: RefusalSeen[];
  swarm: { workers: number; paid: number; hourlyCapCalls: number };
  settlement: { batches: number; gross: bigint; net: bigint; claims: number; unsettledAfter: bigint; txHashes: string[]; txFinal: boolean };
  /**
   * Who paid for the storage the batch wrote, read from the hub: the node's prepaid storage balance before the batch
   * and what the batch took from it. On a real chain also how many bytes the hub account grew and how its own NEAR
   * balance changed; both are null on the simulated hub, which has no NEAR accounts.
   */
  /** `charged` is yoctoNEAR from the settler's balance; `fromReserves` is bytes from the Budgets' owner-paid reserves. */
  storage: { settler: AccountId; receiptKeyOnHub: boolean; prepaidBefore: bigint; charged: bigint; fromReserves: bigint; hubBytesGrown: number | null; hubOwnChange: bigint | null };
  fundFromCredit: { owner: AccountId; amount: bigint; escrowRise: bigint; creditFall: bigint; capUnchanged: boolean } | null;
  payout: { creditors: AccountId[]; transfers: number; paidOut: bigint; balanceRisesMatchCredits: boolean; creditLeft: bigint; txFinal: boolean };
  proofs: { sdk: boolean; mcp: boolean; sdkReason: string | null; mcpReason: string | null };
  settleOwn: { expected: bigint; credited: bigint; claims: number; replayRefused: boolean; checkedAgainst: string; unsettleable: number };
  /**
   * What the hub answered to vouchers the node never accepted, as hub error codes, or "SETTLED" if one went through.
   * `ownerToSelf` and `ownerToAccomplice` are an owner signing with the agent key it chose. `afterRevoke` is a voucher
   * signed after the owner revoked the Budget: `leakedKeyAlone` with an acceptance the signer made up, `datedAfterRevoke`
   * with one signed by the node's own key but dated after the revoke.
   */
  guards: { ownerToSelf: string; ownerToAccomplice: string; leakedKeyAlone: string; datedAfterRevoke: string; escrowUntouched: boolean };
  payeeCheck: PayeeCheckSeen;
  verifier: { genuine: boolean; tamperedRejected: boolean; how: string; receiptPath: string | null };
  hub: HubFacts | null;
  solvent: boolean;
  solvencyError: string | null;
};

/** What the node's payee check says about one account, read from the node (`GET /v1/payees/check`). */
export type NodeVerdict = { verdict: string; signals: string[]; notChecked: string[] };

/** What the chain itself says about one account, read through the payee check's keyless reader. */
export type AccountOnChain = { exists: boolean; registeredWithToken: boolean };

/**
 * The payee-check act. Verdicts and approvals are read from the node's own routes, positions from the node's public
 * position route, and the accounts themselves from the chain. A refusal is what the agent saw.
 */
export type PayeeCheckSeen = {
  /** What the node's check said about each of Globex's payees when the Budget was registered. */
  atRegistration: Array<{ payee: AccountId; status: string; signals: string[] }>;
  /** The injected payee of act 3: an ordinary account that is on no list. */
  unlisted: { payee: AccountId; onChain: AccountOnChain | null; node: NodeVerdict | null };
  lookalike: {
    payee: AccountId;
    /** The allowed payee it imitates. */
    imitates: AccountId;
    onChain: AccountOnChain | null;
    node: NodeVerdict | null;
    /** The wallet's refusal, and its signals. */
    wallet: { rule: string; enforcedBy: string; signals: string[] } | null;
    /** The sum of the node's positions for the wallet's Budget, before and after the attempt. */
    positionBefore: bigint;
    positionAfter: bigint;
    /** The highest cumulative the wallet ever signed for this payee: its own write-ahead record. */
    walletSigned: bigint;
    /** The node's own signed record of the voucher a guard-off runtime sent it. */
    nodeRecord: { rule: string; message: string; signedByNode: boolean } | null;
    /** The node's position for that runtime's Budget and this payee, afterwards. */
    nodePosition: bigint;
    /** What the hub has settled to this payee, from either Budget. */
    settledOnChain: bigint;
  };
  approval: {
    payee: AccountId;
    budgetId: Id32;
    price: bigint;
    onChain: AccountOnChain | null;
    node: NodeVerdict | null;
    positionBefore: bigint;
    /** The first call: it waits. */
    first: { rule: string; enforcedBy: string; retry: RetryHintSeen | null } | null;
    waitingAtNode: { source: string; attempts: number } | null;
    positionWhileWaiting: bigint;
    /** The owner's decision, as the node lists it afterwards. */
    approvedAtNode: { decision: string; signals: string[] | null; decidedBy: string } | null;
    /** The same call again: paid. */
    paid: { callId: Id32; amount: bigint; bookedAtNode: boolean } | null;
    positionAfterPaid: bigint;
    /** True when the node no longer lists a decision for the payee. */
    withdrawn: boolean;
    /** The next call: it waits again. */
    again: { rule: string; enforcedBy: string } | null;
    waitingAgain: boolean;
    positionAfterAgain: bigint;
  };
};

const usdc = (a: bigint | string) => `${formatAmount(a)} USDC`;
const near = (yocto: bigint) => `${(Number(yocto / 10n ** 18n) / 1e6).toFixed(6)} NEAR`;
const short = (id: string) => `${id.slice(0, 8)}...`;
const PAD = 28;

function retryText(r: RetryHintSeen | null): string {
  if (!r) return "no hint";
  if (r.kind === "after") return `after ${String(r.seconds)} s`;
  if (r.kind === "fund") return `after funding ${usdc(String(r.shortBy))}`;
  if (r.kind === "after_settlement") return "after the next settlement";
  if (r.kind === "approval") return `after the owner approves ${String(r.payee)}`;
  return r.kind;
}

/** Counts an SDK client's verified receipts and records its refusals for one act. */
function watch(client: AgentClient, agent: string, act: string, report: Report, say: Say) {
  const offs = [
    client.on("receipt", () => {
      report.paidCalls++;
    }),
    client.on("denied", (d: DeniedEvent) => {
      const r: RefusalSeen = {
        act,
        agent,
        rule: d.code,
        enforcedBy: d.details?.enforcedBy === "agent" ? "agent" : "node",
        attemptedAmount: d.refusal?.attemptedAmount ?? null,
        remainingBudget: d.refusal?.remainingBudget ?? null,
        retry: (d.refusal?.retry as RetryHintSeen | undefined) ?? null,
      };
      report.refusals.push(r);
      say(refusalLine(r));
    }),
  ];
  return () => offs.forEach((off) => off());
}

function refusalLine(r: RefusalSeen): string {
  const left = r.remainingBudget === null ? "" : `, Budget left ${usdc(r.remainingBudget)}`;
  const amount = r.attemptedAmount === null ? "" : `, attempted ${usdc(r.attemptedAmount)}`;
  return `   REFUSED ${r.rule.padEnd(20)} by ${r.enforcedBy.padEnd(5)} ${r.agent}${amount}${left}, retry ${retryText(r.retry)}`;
}

async function paid(res: Response, what: string): Promise<void> {
  if (res.status !== 200) throw new Error(`${what} failed: HTTP ${res.status} ${await res.text()}`);
  await res.body?.cancel();
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

/** The demo's scripted stand-in for Globex's model: it calls the Payminto MCP tools. */
async function tool(s: Stack, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await s.globex.mcp.callTool({ name, arguments: args })) as ToolResult;
}

const resultOf = (r: ToolResult) => (r.structuredContent as { result?: Record<string, unknown> } | undefined)?.result;

/** A refusal a wallet tool returned, as the model sees it: the structured half of the tool error. */
function toolRefusal(r: ToolResult, act: string, agent: string): (RefusalSeen & { signals: string[] }) | null {
  const refusal = r.structuredContent?.refusal as Record<string, unknown> | undefined;
  if (!r.isError || !refusal) return null;
  const details = refusal.details as { payeeCheck?: { signals?: Array<{ id: string }> } } | undefined;
  return {
    act,
    agent,
    rule: String(refusal.rule),
    enforcedBy: refusal.enforcedBy === "agent" ? "agent" : "node",
    attemptedAmount: (refusal.attemptedAmount as string | null) ?? null,
    remainingBudget: (refusal.remainingBudget as string | null) ?? null,
    retry: (refusal.retry as RetryHintSeen | null) ?? null,
    signals: (details?.payeeCheck?.signals ?? []).map((x) => x.id),
  };
}

/** A copy of a receipt file with one field changed: the amount the agent paid, raised by one atomic unit. */
export function tamper(file: ReceiptFile): ReceiptFile {
  return { ...file, receipt: { ...file.receipt, amount: (BigInt(file.receipt.amount) + 1n).toString() } };
}

/** The whole story. Prints as it goes and returns what the checks need. */
export async function runStory(s: Stack, say: Say = () => {}): Promise<Report> {
  const n = (base: number, min = 1) => Math.max(min, Math.round(base * s.cfg.scale));
  // The read side: on sandbox a NearRpcChain with no key, so every fact below comes from the hub itself.
  const chain = s.hub.chain;
  const { owners, sellers } = s.names;
  // Addresses the agents ask to have scanned live under the run's own parent account.
  const tld = sellers.scans.slice(sellers.scans.indexOf(".") + 1);
  const report: Report = {
    label: s.hub.label,
    simulated: s.hub.kind === "fake",
    owners: OWNER_KEYS.map((who) => ({ who, account: owners[who], budgetId: s.budgets[who], ownerOnChain: null })),
    paidCalls: 0,
    refusals: [],
    swarm: { workers: SWARM_SIZE, paid: 0, hourlyCapCalls: Number(s.swarmHourlyCap / PRICES.quote) },
    settlement: { batches: 0, gross: 0n, net: 0n, claims: 0, unsettledAfter: 0n, txHashes: [], txFinal: false },
    storage: { settler: chain.operator, receiptKeyOnHub: false, prepaidBefore: 0n, charged: 0n, fromReserves: 0n, hubBytesGrown: null, hubOwnChange: null },
    fundFromCredit: null,
    payout: { creditors: [], transfers: 0, paidOut: 0n, balanceRisesMatchCredits: false, creditLeft: 0n, txFinal: true },
    proofs: { sdk: false, mcp: false, sdkReason: null, mcpReason: null },
    settleOwn: { expected: 0n, credited: 0n, claims: 0, replayRefused: false, checkedAgainst: "nothing", unsettleable: 0 },
    guards: { ownerToSelf: "not tried", ownerToAccomplice: "not tried", leakedKeyAlone: "not tried", datedAfterRevoke: "not tried", escrowUntouched: false },
    payeeCheck: {
      atRegistration: s.payeeVerdicts.globex,
      unlisted: { payee: sellers.alpha, onChain: null, node: null },
      lookalike: { payee: sellers.mirror, imitates: sellers.scans, onChain: null, node: null, wallet: null, positionBefore: 0n, positionAfter: 0n, walletSigned: 0n, nodeRecord: null, nodePosition: 0n, settledOnChain: 0n },
      approval: {
        payee: sellers.fresh,
        budgetId: s.budgets.globex,
        price: PRICES.feed,
        onChain: null,
        node: null,
        positionBefore: 0n,
        first: null,
        waitingAtNode: null,
        positionWhileWaiting: 0n,
        approvedAtNode: null,
        paid: null,
        positionAfterPaid: 0n,
        withdrawn: false,
        again: null,
        waitingAgain: false,
        positionAfterAgain: 0n,
      },
    },
    verifier: { genuine: false, tamperedRejected: false, how: "not run", receiptPath: null },
    hub: null,
    solvent: false,
    solvencyError: null,
  };

  say("");
  say(`Chain: ${s.hub.label}. Hub ${chain.hub}, token ${chain.token}, node ${chain.operator}.`);
  say(`Run directory (disposable): ${s.runDir}`);
  say("");
  say("1. Owners open Budgets from their own wallets. Cap is authority; escrow is funding.");
  for (const o of report.owners) {
    const b = (await chain.budget(o.budgetId))!;
    o.ownerOnChain = b.owner;
    const p = s.policies[o.who];
    const hourly = p.hourlyCap ? `, hourly cap ${usdc(p.hourlyCap)}` : "";
    const repeats = p.maxRepeatsPerRequest ? `, ${p.maxRepeatsPerRequest} repeats per request` : "";
    say(`   ${o.account.padEnd(PAD)} Budget ${short(o.budgetId)} cap ${usdc(b.cap)}, escrow ${usdc(b.escrow)}${hourly}${repeats}, payees ${b.payees.join(", ")}`);
  }
  // The node looked at every listed payee when each Budget was registered, and said what it found in its answer.
  const flagged = OWNER_KEYS.flatMap((who) => s.payeeVerdicts[who].filter((v) => v.status !== "allow").map((v) => `${v.payee} on ${owners[who]}'s list: ${v.status.toUpperCase()} (${v.signals.join(", ")})`));
  const looked = OWNER_KEYS.reduce((n, who) => n + s.payeeVerdicts[who].length, 0);
  say(`   Payee check at registration: the node looked at ${looked} listed payees. ${flagged.length ? flagged.join("; ") : "It has nothing against any of them"}.`);

  say("");
  say("2. Agents pay per call with signed vouchers over HTTP 402 (x402 v2, scheme payminto-voucher).");
  // Acme buys quotes from Globex and scans; Globex buys briefs from Acme: they owe each other, so it offsets.
  let off = watch(s.acme, "acme agent", "traffic", report, say);
  const quotes = n(100);
  for (let i = 0; i < quotes; i++) await paid(await s.acme.fetch(`${s.urls.quotes}/v1/quote?symbol=${["NEAR", "BTC", "ETH"][i % 3]}&i=${i}`), "acme quote");
  const acmeScans = n(10);
  for (let i = 0; i < acmeScans; i++) await paid(await s.acme.fetch(`${s.urls.scans}/v1/scan?address=vendor-${i}.${tld}`), "acme scan");
  off();
  say(`   acme agent (SDK)      bought ${quotes} quotes from Globex and ${acmeScans} risk scans`);

  const briefs = n(8, 2);
  let injected: string | null = null;
  let moved: string | null = null;
  for (let i = 0; i < briefs; i++) {
    const r = await tool(s, "call_paid_service", { url: `${s.urls.briefs}/v1/brief`, body: { topic: `NEAR outlook ${i}` } });
    if (r.isError) throw new Error(`globex brief failed: ${r.content[0]?.text}`);
    report.paidCalls++;
    const notes = (resultOf(r)?.response as { communityNotes?: Array<{ text: string }> } | undefined)?.communityNotes;
    injected ??= notes?.[0]?.text ?? null;
    moved ??= notes?.[1]?.text ?? null;
  }
  const globexScans = n(20);
  for (let i = 0; i < globexScans; i++) {
    const r = await tool(s, "call_paid_service", { url: `${s.urls.scans}/v1/scan`, query: { address: `counterparty-${i}.${tld}` } });
    if (r.isError) throw new Error(`globex scan failed: ${r.content[0]?.text}`);
    report.paidCalls++;
  }
  say(`   globex agent (MCP)    bought ${briefs} research briefs from Acme and ${globexScans} risk scans through call_paid_service`);

  say("");
  say("3. Policy refuses what the owner did not allow, and names the rule that fired.");
  say(`   A paid brief carried a planted instruction: "${(injected ?? "").slice(0, 72)}..."`);
  // The scripted model obeys the injection; the wallet refuses before signing anything.
  const seen = (r: (RefusalSeen & { signals: string[] }) | null) => {
    if (!r) return null;
    const { signals: _signals, ...refusal } = r;
    report.refusals.push(refusal);
    say(refusalLine(refusal));
    return r;
  };
  seen(toolRefusal(await tool(s, "call_paid_service", { url: `${s.urls.alpha}/v1/alpha` }), "injection", "globex agent (MCP)"));
  // A compromised runtime with Acme's key and its guard off signs anyway: the node refuses it and records why.
  off = watch(s.acmeCompromised, "acme runtime, guard off", "injection", report, say);
  await (await s.acmeCompromised.fetch(`${s.urls.alpha}/v1/alpha`)).body?.cancel();
  off();

  // Initech's agent loops on one request, then keeps buying past what its escrow can cover before a settlement.
  off = watch(s.initech, "initech agent", "loop", report, say);
  for (let i = 0; i < 4; i++) await (await s.initech.fetch(`${s.urls.scans}/v1/scan?address=${owners.initech}`)).body?.cancel();
  const before = report.refusals.length;
  for (let i = 0; i < 40 && !report.refusals.slice(before).some((r) => r.rule === "NET_EXPOSURE"); i++) {
    await (await s.initech.fetch(`${s.urls.scans}/v1/scan?address=supplier-${i}.${tld}`)).body?.cancel();
  }
  off();

  // The DAO's swarm: three agents share one Budget. Each one's own guard sees only its own spend, so the hourly cap on
  // their combined spend is enforced by the node.
  const swarmOffs = s.swarm.map((w, i) => watch(w, `dao swarm worker ${i + 1}`, "swarm", report, say));
  const swarmStart = report.paidCalls;
  const swarmBefore = report.refusals.length;
  for (let i = 0; i < report.swarm.hourlyCapCalls + SWARM_SIZE && report.refusals.length === swarmBefore; i++) {
    await (await s.swarm[i % SWARM_SIZE]!.fetch(`${s.urls.quotes}/v1/quote?symbol=NEAR&watch=${i}`)).body?.cancel();
  }
  swarmOffs.forEach((o) => o());
  report.swarm.paid = report.paidCalls - swarmStart;
  say(`   dao swarm             ${SWARM_SIZE} workers paid ${report.swarm.paid} quotes between them, then the shared hourly cap of ${usdc(s.swarmHourlyCap)} fired`);

  say("");
  say("4. The node nets what owners owe each other and settles one batch on the hub.");
  const accounts = [...Object.values(owners), sellers.scans];
  const creditBefore = new Map(await Promise.all(accounts.map(async (a) => [a, await chain.creditOf(a)] as const)));
  // The hub never pays for the storage a batch writes: each Budget's new payees come out of the reserve its owner
  // prepaid at open_budget, and the batch record out of the node's prepaid storage balance.
  const nodeKey = s.node.services.chain.nodeKey;
  report.storage.receiptKeyOnHub = (await chain.receiptKeys(chain.operator)).includes(nodeKey);
  report.storage.prepaidBefore = await chain.storageOf(chain.operator);
  const reserves = async () => {
    let bytes = 0n;
    for (const who of OWNER_KEYS) bytes += (await chain.budget(s.budgets[who]))?.storageReserveBytes ?? 0n;
    return bytes;
  };
  const reservesBefore = await reserves();
  const nearBefore = await s.hub.near();
  const settled = await s.node.services.settlement.settle("manual");
  if ("skipped" in settled) throw new Error(`settlement skipped: ${settled.skipped}`);
  report.storage.charged = report.storage.prepaidBefore - (await chain.storageOf(chain.operator));
  report.storage.fromReserves = reservesBefore - (await reserves());
  const nearAfter = await s.hub.near();
  if (nearBefore && nearAfter) {
    report.storage.hubBytesGrown = nearAfter.storageBytes - nearBefore.storageBytes;
    report.storage.hubOwnChange = nearAfter.ownYocto - nearBefore.ownYocto;
  }
  let final = settled.batchIds.length > 0;
  for (const [i, id] of settled.batchIds.entries()) {
    const b = await chain.batch(id, chain.operator);
    if (!b) throw new Error(`batch ${id} is not on the hub`);
    report.settlement.gross += b.gross;
    report.settlement.net += b.net;
    // The node reports the hash; the chain says whether that transaction is final.
    const hash = settled.batches[i]?.txHash ?? null;
    const state = hash ? await chain.txState(hash) : null;
    if (state?.status !== "final") final = false;
    if (hash) report.settlement.txHashes.push(hash);
    say(`     tx ${hash ?? "(none)"}  ${b.settler}: settle_batch ${short(id)}, ${state?.status ?? "no hash"} on chain, root ${short(b.root)}`);
  }
  report.settlement.txFinal = final;
  report.settlement.batches = settled.batchIds.length;
  report.settlement.claims = settled.batches.reduce((sum, b) => sum + Number((b as { claims?: number }).claims ?? 0), 0);
  const gross = report.settlement.gross;
  const net = report.settlement.net;
  say(`   ${settled.batchIds.length} batch(es), root on the hub. Gross cleared ${usdc(gross)} across ${report.paidCalls} paid calls.`);
  say(`   Tokens moved inside the hub (escrow to credit): ${usdc(net)}. Offset between owners: ${usdc(gross - net)}.`);
  const st = report.storage;
  const onChain = st.hubBytesGrown === null ? "" : ` The hub account grew by ${st.hubBytesGrown} bytes, and its own NEAR balance changed by ${st.hubOwnChange} yoctoNEAR.`;
  say(`   Storage: ${st.fromReserves} bytes for new payees from the Budgets' reserves their owners prepaid, and ${st.charged / STORAGE_BYTE_COST} bytes for the batch record (${near(st.charged)}) from ${chain.operator}'s prepaid storage balance of ${near(st.prepaidBefore)}, not from the hub.${onChain}`);
  for (const who of OWNER_KEYS) {
    const b = (await chain.budget(s.budgets[who]))!;
    const credit = (await chain.creditOf(owners[who])) - (creditBefore.get(owners[who]) ?? 0n);
    say(`   ${owners[who].padEnd(PAD)} spent ${usdc(b.spent).padEnd(14)} escrow left ${usdc(b.escrow).padEnd(14)} credit earned ${usdc(credit)}`);
  }
  say(`   ${sellers.scans.padEnd(PAD)} credit earned ${usdc((await chain.creditOf(sellers.scans)) - (creditBefore.get(sellers.scans) ?? 0n))} (a pure seller, no Budget)`);

  // Acme earned more than it spent. It moves half of that credit into its own Budget's escrow from its own wallet:
  // escrow rises, cap does not, and no token leaves the hub.
  const acmeCredit = await chain.creditOf(owners.acme);
  if (acmeCredit > 0n) {
    const amount = acmeCredit / 2n > 0n ? acmeCredit / 2n : acmeCredit;
    const b0 = (await chain.budget(s.budgets.acme))!;
    say(`   Acme moves ${usdc(amount)} of its ${usdc(acmeCredit)} credit into its Budget with fund_from_credit, signed by its own wallet:`);
    await s.hub.wallets.fundFromCredit(owners.acme, s.budgets.acme, amount);
    const b1 = (await chain.budget(s.budgets.acme))!;
    const creditAfter = await chain.creditOf(owners.acme);
    report.fundFromCredit = { owner: owners.acme, amount, escrowRise: b1.escrow - b0.escrow, creditFall: acmeCredit - creditAfter, capUnchanged: b1.cap === b0.cap };
    say(`   ${owners.acme.padEnd(PAD)} escrow ${usdc(b0.escrow)} -> ${usdc(b1.escrow)}, cap ${usdc(b1.cap)} unchanged, credit ${usdc(acmeCredit)} -> ${usdc(creditAfter)}`);
  }

  say("");
  say("5. Payout: net creditors withdraw. One token transfer per creditor, not per call.");
  const creditors: AccountId[] = [];
  for (const a of accounts) if ((await chain.creditOf(a)) > 0n) creditors.push(a);
  const credits = new Map(await Promise.all(creditors.map(async (a) => [a, await chain.creditOf(a)] as const)));
  const balances = new Map(await Promise.all(creditors.map(async (a) => [a, await chain.balanceOf(a)] as const)));
  // The node pays out the net creditors its batches queued (POST /v1/payouts, at most ten accounts per hub call).
  const res = await fetch(`${s.nodeUrl}/v1/payouts`, { method: "POST", headers: { authorization: `Bearer ${s.adminToken}` } });
  if (res.status !== 200) throw new Error(`POST /v1/payouts: HTTP ${res.status} ${await res.text()}`);
  const run = (await res.json()) as { payouts?: Array<{ txHash: string | null; status: string; items: Array<{ account: string; outcome: string }> }>; waitingRegistration?: string[]; skipped?: string };
  if (run.skipped) throw new Error(`the node skipped the payout: ${run.skipped}`);
  for (const p of run.payouts ?? []) {
    // The node reports the hash; the chain says whether that transaction is final.
    const state = p.txHash ? await chain.txState(p.txHash) : null;
    if (state?.status !== "final") report.payout.txFinal = false;
    say(`     tx ${p.txHash ?? "(none)"}  ${chain.operator}: payout to ${p.items.map((i) => i.account).join(", ")}, ${state?.status ?? "no hash"} on chain`);
  }
  report.payout.txFinal &&= (run.payouts ?? []).length > 0;
  if (run.waitingRegistration?.length) say(`   waiting for token registration: ${run.waitingRegistration.join(", ")}`);
  let rises = true;
  for (const a of creditors) {
    const rise = (await chain.balanceOf(a)) - balances.get(a)!;
    if (rise > 0n) report.payout.transfers++;
    report.payout.paidOut += rise;
    if (rise !== credits.get(a)) rises = false;
    report.payout.creditLeft += await chain.creditOf(a);
    say(`   ${a.padEnd(PAD)} received ${usdc(rise)}`);
  }
  report.payout.creditors = creditors;
  report.payout.balanceRisesMatchCredits = rises;
  say(`   ${report.payout.transfers} transfers for ${report.paidCalls} paid calls.`);

  say("");
  say("6. Anyone can prove one call against the root the hub stores.");
  const mine: ClearingReceipt[] = s.acme.receipts.all().filter((r) => r.budgetId === s.budgets.acme);
  const sample = mine[Math.floor(mine.length / 2)];
  let written: ReceiptFile | null = null;
  if (sample) {
    const res = await fetch(`${s.nodeUrl}/v1/receipts/${sample.callId}/proof`);
    const p = (await res.json()) as { batchId: Id32 | null; proof: Id32[] };
    if (p.batchId) {
      const check = await verifyReceiptOnchain({ chain, operator: s.names.operator, nodeKey: s.node.services.chain.nodeKey, agentPk: s.keys.acme.publicKey, receipt: sample, batchId: p.batchId, proof: p.proof });
      report.proofs.sdk = check.verified;
      report.proofs.sdkReason = check.reason;
      say(`   SDK: call ${short(sample.callId)} (acme, ${usdc(sample.amount)}) in batch ${short(p.batchId)}, ${p.proof.length}-step Merkle path: ${check.verified ? "PROVEN" : `NOT PROVEN (${check.reason})`}`);
      written = receiptFile({ network: chain.network, hub: chain.hub, operator: s.names.operator, rpcUrl: s.hub.rpcUrl, batchId: p.batchId, proof: p.proof, receipt: sample });
      report.verifier.receiptPath = join(s.runDir, "receipt.json");
      writeFileSync(report.verifier.receiptPath, `${JSON.stringify(written, null, 2)}\n`);
      say(`   Wrote that receipt and its Merkle path to ${report.verifier.receiptPath}`);
    }
  }
  const listed = resultOf(await tool(s, "get_receipts", { limit: 1 })) as unknown as Array<{ callId: Id32 }> | undefined;
  const target = (Array.isArray(listed) ? listed : [])[0];
  if (target) {
    const proved = resultOf(await tool(s, "prove_receipt", { callId: target.callId })) as { independentlyVerifiedOnchain?: boolean | null; notVerifiedBecause?: string | null } | undefined;
    report.proofs.mcp = proved?.independentlyVerifiedOnchain === true;
    report.proofs.mcpReason = proved?.notVerifiedBecause ?? null;
    say(`   MCP prove_receipt: call ${short(target.callId)} (globex): ${report.proofs.mcp ? "PROVEN" : `NOT PROVEN (${report.proofs.mcpReason})`}`);
  }
  say("   This proves inclusion and that the agent signed the call. It does not prove delivery, or that the root covers every voucher.");

  await payeeCheckAct(s, report, say, { moved, seen });

  say("");
  say("8. The node goes away. A seller settles its own earnings with settle_own from its exported vouchers.");
  const late = n(5, 2);
  off = watch(s.acme, "acme agent", "late", report, say);
  for (let i = 0; i < late; i++) await paid(await s.acme.fetch(`${s.urls.scans}/v1/scan?address=late-${i}.${tld}`), "late scan");
  off();
  report.settleOwn.expected = BigInt(late) * PRICES.scan;
  await s.stopNode();
  say(`   acme paid ${late} more scans (${usdc(report.settleOwn.expected)}), then the node stopped before settling them.`);
  // The seller restarts from its voucher file, exports, and its own wallet signs settle_own.
  s.paywalls.scans.vouchers.close?.();
  const reopened = new FileVoucherStore(s.scanVoucherPath);
  const exportPath = join(s.runDir, "scan-vouchers.export.json");
  writeFileSync(exportPath, `${JSON.stringify(exportVouchers(reopened, { hub: chain.hub, network: chain.network, payee: sellers.scans }), null, 2)}\n`);
  reopened.close();
  // Each voucher is checked against its Budget's agent key on the hub, and each acceptance against the node's receipt keys there.
  const exp = await parseVoucherExport(JSON.parse(readFileSync(exportPath, "utf8")), chain);
  const plan = await settleOwnClaims(exp, sellers.scans, chain);
  const claims = plan.claims;
  report.settleOwn.checkedAgainst = exp.checkedAgainst;
  report.settleOwn.unsettleable = plan.unsettleable.length;
  say(`   exported ${exp.vouchers.length} latest voucher(s), each with the node's acceptance, to ${exportPath} (checked against the ${exp.checkedAgainst}); ${claims.length} of them hold calls the hub has not settled`);
  for (const u of plan.unsettleable) say(`   cannot settle voucher ${short(u.voucher.callId)}: ${u.reason}`);
  const creditBeforeOwn = await chain.creditOf(sellers.scans);
  for (const c of claims) await s.hub.wallets.settleOwn(sellers.scans, c.claim, c.acceptance);
  report.settleOwn.claims = claims.length;
  report.settleOwn.credited = (await chain.creditOf(sellers.scans)) - creditBeforeOwn;
  const answer = async (payee: AccountId, claim: Claim, acceptance: Acceptance): Promise<string> => {
    try {
      await s.hub.wallets.settleOwn(payee, claim, acceptance);
      return "SETTLED";
    } catch (err) {
      if (err instanceof ChainError) return err.code;
      throw err;
    }
  };
  if (claims[0]) report.settleOwn.replayRefused = (await answer(sellers.scans, claims[0].claim, claims[0].acceptance)) === "STALE_VOUCHER";
  say(`   settle_own: ${claims.length} claim(s), ${usdc(report.settleOwn.credited)} credited to ${sellers.scans}; a replay is refused: ${report.settleOwn.replayRefused}`);

  // settle_own takes a voucher only with the node's acceptance of that exact call. Without that rule the owner, who
  // chose the agent key, could sign a voucher to itself and empty its escrow ahead of the sellers the node accepted.
  say("   settle_own is no way around the node: the hub refuses vouchers the node never accepted.");
  const sign = (key: Keypair, budgetId: Id32, payee: AccountId, amount: bigint, cumulative: bigint): Claim => {
    const voucher = { budgetId, payee, amount, cumulative, requestHash: "00".repeat(32) };
    return { ...voucher, signature: signDigest(key.secretKey, voucherDigest(chain.hub, chain.network, voucher)) };
  };
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  const acme = (await chain.budget(s.budgets.acme))!;
  const toSelf = sign(s.keys.acme, acme.id, owners.acme, acme.escrow, acme.escrow);
  report.guards.ownerToSelf = await answer(owners.acme, toSelf, signAcceptance(s.keys.acme, toSelf, nowS));
  const accomplice = sellers.quotes;
  const toAccomplice = sign(s.keys.acme, acme.id, accomplice, acme.escrow, (await chain.settledOf(acme.id, accomplice)) + acme.escrow);
  report.guards.ownerToAccomplice = await answer(accomplice, toAccomplice, signAcceptance(s.keys.acme, toAccomplice, nowS));
  say(`   ${owners.acme} signs ${usdc(acme.escrow)} to itself with its agent key: ${report.guards.ownerToSelf}. To ${accomplice}, with an acceptance it signed itself: ${report.guards.ownerToAccomplice}.`);

  // Initech revokes its Budget from its own wallet. A voucher signed with its agent key after that cannot be settled.
  await s.hub.wallets.revokeBudget(owners.initech, s.budgets.initech);
  const initech = (await chain.budget(s.budgets.initech))!;
  const revokedAt = initech.revokedAt!;
  const stolen = sign(s.keys.initech, initech.id, sellers.scans, PRICES.scan, (await chain.settledOf(initech.id, sellers.scans)) + PRICES.scan);
  report.guards.leakedKeyAlone = await answer(sellers.scans, stolen, signAcceptance(s.keys.initech, stolen, revokedAt / 1000n));
  // Even the node's own key cannot vouch for it once the acceptance is dated after the revoke.
  const dated = revokedAt / 1000n + 1n;
  const byNode: Acceptance = { nodeKey, timestampS: dated, signature: s.node.services.chain.signAcceptance(acceptanceDigest(stolen, dated)) };
  report.guards.datedAfterRevoke = await answer(sellers.scans, stolen, byNode);
  say(`   ${owners.initech} revoked its Budget at ${new Date(Number(revokedAt)).toISOString()}. A voucher signed with its agent key afterwards: ${report.guards.leakedKeyAlone}; with the node's own signature dated one second after the revoke: ${report.guards.datedAfterRevoke}.`);
  const [acmeAfter, initechAfter] = [(await chain.budget(acme.id))!, (await chain.budget(initech.id))!];
  report.guards.escrowUntouched = acmeAfter.escrow === acme.escrow && initechAfter.escrow === initech.escrow && acmeAfter.spent === acme.spent && initechAfter.spent === initech.spent;

  say("");
  say("9. Anyone can check a receipt with no node and no keys.");
  if (written && report.verifier.receiptPath) {
    const tamperedPath = join(s.runDir, "receipt.tampered.json");
    writeFileSync(tamperedPath, `${JSON.stringify(tamper(written), null, 2)}\n`);
    if (s.hub.rpcUrl) {
      // The verifier as a judge runs it: a separate process with only an RPC URL, a hub account and a file.
      report.verifier.how = "pnpm verify:near, a separate process with no node and no keys";
      const genuine = await runVerifierCli(["--rpc-url", s.hub.rpcUrl, "--hub", chain.hub, "--receipt", report.verifier.receiptPath]);
      const tampered = await runVerifierCli(["--rpc-url", s.hub.rpcUrl, "--hub", chain.hub, "--receipt", tamperedPath]);
      report.verifier.genuine = genuine.code === 0;
      report.verifier.tamperedRejected = tampered.code === 1;
      say(`   verify:near --receipt receipt.json          exit ${genuine.code}: ${genuine.summary}`);
      say(`   verify:near --receipt receipt.tampered.json exit ${tampered.code}: ${tampered.summary}`);
    } else {
      // The simulated hub lives in this process, so the verifier's checks run here against it.
      report.verifier.how = "the verifier's checks, in process against the simulated hub";
      const genuine = await verifyReceipt(chain, receiptFileSchema.parse(written));
      const tampered = await verifyReceipt(chain, receiptFileSchema.parse(tamper(written)));
      report.verifier.genuine = genuine.ok;
      report.verifier.tamperedRejected = !tampered.ok;
      say(`   receipt.json: ${genuine.ok ? "PROVEN" : "NOT PROVEN"}; receipt.tampered.json (amount + 1): ${tampered.ok ? "PROVEN" : "REJECTED"}`);
    }
  } else {
    say("   no receipt was written, so there is nothing to check");
  }

  report.hub = await s.hub.facts();
  try {
    await s.hub.solvency();
    report.solvent = true;
  } catch (err) {
    report.solvencyError = err instanceof Error ? err.message : String(err);
  }
  return report;
}

/**
 * Act 7. Before a Budget pays an account, the wallet and the node look at that account. Three accounts show the three
 * answers: an ordinary account the check allows (and the Budget's list refuses), a lookalike of an allowed payee that
 * it blocks, and a listed vendor it warns about, which waits for the owner.
 *
 * It runs after the batch is settled and paid out, so the one call it pays is cleared and not yet settled.
 */
async function payeeCheckAct(
  s: Stack,
  report: Report,
  say: Say,
  o: { moved: string | null; seen: (r: (RefusalSeen & { signals: string[] }) | null) => (RefusalSeen & { signals: string[] }) | null },
): Promise<void> {
  const chain = s.hub.chain;
  const { owners, sellers } = s.names;
  const pc = report.payeeCheck;
  const admin = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${s.nodeUrl}${path}`, { method, headers: { authorization: `Bearer ${s.adminToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  /** The node's position for a Budget and a payee: the public route an agent reads before it signs. */
  const position = async (budgetId: Id32, payee: AccountId): Promise<bigint> => {
    const res = await fetch(`${s.nodeUrl}/v1/budgets/${budgetId}/position?payee=${encodeURIComponent(payee)}`);
    if (res.status !== 200) throw new Error(`GET position of ${payee}: HTTP ${res.status} ${await res.text()}`);
    return BigInt(((await res.json()) as { cumulative: string }).cumulative);
  };
  /** The node's verdict for an account, judged for one Budget. The node reads the chain for it. */
  const verdict = async (account: AccountId, budgetId: Id32): Promise<NodeVerdict> => {
    const r = await admin("GET", `/v1/payees/check?account=${encodeURIComponent(account)}&budget=${budgetId}`);
    if (r.status !== 200) throw new Error(`GET /v1/payees/check for ${account}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    const v = r.json as { verdict: string; signals: Array<{ id: string; severity: string }>; notChecked: string[] };
    return { verdict: v.verdict, signals: v.signals.filter((x) => x.severity !== "info").map((x) => x.id), notChecked: v.notChecked };
  };
  /** The account as the chain has it, through the same keyless reader the check uses. */
  const onChain = async (account: AccountId): Promise<AccountOnChain> => {
    const exists = (await s.hub.payeeReader.viewAccount(account)) !== null;
    return { exists, registeredWithToken: exists && (await s.hub.payeeReader.storageBalanceOf(chain.token, account)) !== null };
  };
  const approvals = async (budgetId: Id32) => {
    const r = await admin("GET", `/v1/budgets/${budgetId}/payee-approvals`);
    if (r.status !== 200) throw new Error(`GET payee-approvals: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    return r.json as {
      approvals: Array<{ payee: AccountId; decision: string; signals: string[] | null; decidedBy: { type: string; id: string | null } }>;
      waiting: Array<{ payee: AccountId; source: string; attempts: number }>;
    };
  };
  const words = (v: NodeVerdict) => `${v.verdict.toUpperCase()}${v.signals.length ? ` (${v.signals.join(", ")})` : ""}`;
  const state = (a: AccountOnChain) => (a.exists ? `exists, ${a.registeredWithToken ? "registered" : "not registered"} with ${chain.token}` : "does not exist");
  const globex = s.budgets.globex;

  say("");
  say("7. The payee check. Before a Budget pays an account, the wallet and the node look at that account on chain.");
  [pc.unlisted.onChain, pc.lookalike.onChain, pc.approval.onChain] = await Promise.all([onChain(sellers.alpha), onChain(sellers.mirror), onChain(sellers.fresh)]);
  pc.unlisted.node = await verdict(sellers.alpha, globex);
  pc.lookalike.node = await verdict(sellers.mirror, globex);
  pc.approval.node = await verdict(sellers.fresh, globex);
  say(`   ${sellers.alpha.padEnd(PAD)} ${state(pc.unlisted.onChain)}. The node's check: ${words(pc.unlisted.node)}. It is on no list, so act 3 refused it with PAYEE_NOT_ALLOWED.`);
  say(`   ${sellers.mirror.padEnd(PAD)} ${state(pc.lookalike.onChain)}. The node's check: ${words(pc.lookalike.node)}. It reads like ${sellers.scans}, which Globex and Acme allow.`);
  say(`   ${sellers.fresh.padEnd(PAD)} ${state(pc.approval.onChain)}. The node's check: ${words(pc.approval.node)}. It is on Globex's list.`);
  if (pc.approval.node.notChecked.length) say(`   Not checked here: ${pc.approval.node.notChecked.join("; ")}.`);

  // 7a. The attack. The scripted model obeys a planted note and asks the wallet to pay the lookalike's service.
  say(`   The brief of act 2 carried a second planted instruction: "${(o.moved ?? "").slice(0, 110)}..."`);
  const mirrorUrl = `${s.urls.mirror}/v1/scan`;
  const globexPayees = [sellers.briefs, sellers.scans, sellers.fresh, sellers.mirror];
  const total = async () => (await Promise.all(globexPayees.map((p) => position(globex, p)))).reduce((a, b) => a + b, 0n);
  pc.lookalike.positionBefore = await total();
  const blocked = o.seen(toolRefusal(await tool(s, "call_paid_service", { url: mirrorUrl, query: { address: owners.globex } }), "payee check", "globex agent (MCP)"));
  if (blocked) pc.lookalike.wallet = { rule: blocked.rule, enforcedBy: blocked.enforcedBy, signals: blocked.signals };
  pc.lookalike.positionAfter = await total();
  pc.lookalike.walletSigned = s.globex.wallet.agent.receipts.signedPosition(globex, sellers.mirror);
  say(`   The wallet signed nothing: its signed position for ${sellers.mirror} is ${pc.lookalike.walletSigned}, and the node's positions for Globex's Budget stayed at ${usdc(pc.lookalike.positionAfter)}.`);
  // A compromised runtime with Acme's key signs the voucher anyway. The node looks at the payee itself and refuses.
  const rawUrl = `${mirrorUrl}?address=${owners.acme}`;
  const off = watch(s.acmeCompromised, "acme runtime, guard off", "payee check", report, say);
  await (await s.acmeCompromised.fetch(rawUrl)).body?.cancel();
  off();
  // The node's own record of that refusal, signed with its receipt key: a seller's relayed words are not the proof.
  const lookup = await fetch(`${s.nodeUrl}/v1/budgets/${s.budgets.acme}/refusals?requestHash=${computeRequestHash("GET", rawUrl)}&payee=${encodeURIComponent(sellers.mirror)}`);
  const records = lookup.status === 200 ? ((await lookup.json()) as { refusals: Array<RefusalRecord & { nodeSignature: Sig64 }> }).refusals : [];
  const record = records[0];
  if (record) {
    pc.lookalike.nodeRecord = { rule: record.refusal.rule, message: record.refusal.message, signedByNode: refusalSignedBy(chain.hub, chain.network, record, record.nodeSignature, s.node.services.chain.nodeKey) };
    say(`   The node's signed record of that refusal: ${record.refusal.rule}, "${record.refusal.message.slice(0, 120)}${record.refusal.message.length > 120 ? "..." : ""}"`);
  }
  pc.lookalike.nodePosition = await position(s.budgets.acme, sellers.mirror);
  pc.lookalike.settledOnChain = (await chain.settledOf(globex, sellers.mirror)) + (await chain.settledOf(s.budgets.acme, sellers.mirror));

  // 7b. A listed vendor with a warning. The call waits, the owner approves on the node, and the same call is paid.
  const feed = { url: `${s.urls.feed}/v1/feed`, query: { n: 1 } };
  const a = pc.approval;
  a.positionBefore = await position(globex, sellers.fresh);
  const first = o.seen(toolRefusal(await tool(s, "call_paid_service", feed), "payee check", "globex agent (MCP)"));
  if (first) a.first = { rule: first.rule, enforcedBy: first.enforcedBy, retry: first.retry };
  const held = (await approvals(globex)).waiting.find((w) => w.payee === sellers.fresh);
  a.waitingAtNode = held ? { source: held.source, attempts: held.attempts } : null;
  a.positionWhileWaiting = await position(globex, sellers.fresh);
  const approveAt = a.first?.retry?.kind === "approval" ? String(a.first.retry.approveAt) : "(no page named)";
  say(`   The node lists the call as waiting (GET /v1/budgets/${short(globex)}/payee-approvals: ${held ? `asked by the ${held.source}, ${held.attempts} time(s)` : "NOT LISTED"}). The owner decides at ${approveAt}.`);

  const decided = await admin("POST", `/v1/budgets/${globex}/payee-approvals`, { payee: sellers.fresh, decision: "approve", note: "New desk vendor, contract signed" });
  if (decided.status !== 200) throw new Error(`the node refused the owner's approval: HTTP ${decided.status} ${JSON.stringify(decided.json)}`);
  const listed = (await approvals(globex)).approvals.find((x) => x.payee === sellers.fresh);
  a.approvedAtNode = listed ? { decision: listed.decision, signals: listed.signals, decidedBy: listed.decidedBy.type } : null;
  say(`   ${owners.globex} approves it on the node (POST /v1/budgets/${short(globex)}/payee-approvals, decision approve), for the warnings it saw: ${(listed?.signals ?? []).join(", ") || "none"}.`);

  const second = await tool(s, "call_paid_service", feed);
  const paid = (resultOf(second)?.payment ?? null) as { callId: Id32; payee: AccountId; amountAtomic: string } | null;
  if (second.isError || !paid) throw new Error(`the approved call was not paid: ${second.content[0]?.text}`);
  report.paidCalls++;
  // The node booked the call: its public receipt route answers for the call id the wallet was given.
  const booked = await fetch(`${s.nodeUrl}/v1/receipts/${paid.callId}/proof`);
  const bookedFor = booked.status === 200 ? ((await booked.json()) as { receipt: { payee: AccountId; amount: string } }).receipt : null;
  a.paid = { callId: paid.callId, amount: BigInt(paid.amountAtomic), bookedAtNode: bookedFor?.payee === sellers.fresh && bookedFor.amount === paid.amountAtomic };
  a.positionAfterPaid = await position(globex, sellers.fresh);
  say(`   The same call is paid: ${usdc(paid.amountAtomic)} to ${paid.payee}, call ${short(paid.callId)}; the node's position for it went ${usdc(a.positionBefore)} -> ${usdc(a.positionAfterPaid)}.`);

  const withdrawn = await admin("DELETE", `/v1/budgets/${globex}/payee-approvals/${encodeURIComponent(sellers.fresh)}`);
  if (withdrawn.status !== 200) throw new Error(`the node refused to withdraw the approval: HTTP ${withdrawn.status} ${JSON.stringify(withdrawn.json)}`);
  say(`   ${owners.globex} withdraws the approval (DELETE /v1/budgets/${short(globex)}/payee-approvals/${sellers.fresh}). The next call:`);
  const again = o.seen(toolRefusal(await tool(s, "call_paid_service", { ...feed, query: { n: 2 } }), "payee check", "globex agent (MCP)"));
  if (again) a.again = { rule: again.rule, enforcedBy: again.enforcedBy };
  const after = await approvals(globex);
  a.withdrawn = !after.approvals.some((x) => x.payee === sellers.fresh);
  a.waitingAgain = after.waiting.some((w) => w.payee === sellers.fresh);
  a.positionAfterAgain = await position(globex, sellers.fresh);
  say(`   It waits again, and the position stays at ${usdc(a.positionAfterAgain)}. The wallet has no tool that approves a payee: only the owner does, on the node.`);
}
