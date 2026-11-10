/**
 * In-memory Clearing Node for NEXT_PUBLIC_MOCK=1.
 * Deterministic fixtures (3 providers, 2 agents plus Research Writer buying on its own budget, ~530 calls,
 * 2 settled batches and denials) built with the real protocol helpers, so Merkle proofs and netting are genuine.
 */
import {
  budgetIdOf,
  budgetTermsFromJson,
  id32Bytes,
  keypairFromSeed,
  publicKeyToString,
  type BudgetTermsJson,
  buildReceiptTree,
  DENIAL_RULES,
  explorerTx,
  HUB_UNREADABLE_MESSAGE,
  networkFor,
  NEAR_TESTNET_USDC,
  policyHash,
  publicKeyBytes,
  receiptLeaf,
  sha256Text,
  toHex,
  verifyMerkleProof,
  type AccountId,
  type DenialRule,
  type Id32,
  type Network,
  type Policy,
  type PublicKey,
  type ReceiptFields,
  type ReceiptTree,
  type BudgetRefusal,
  type Refusal,
  type RetryHint,
  type WalletTx,
} from "@payminto/protocol";
import type { CallsQuery, ClearingApi, CreateBudgetBody, CreateProviderBody, Page, PayeeDecisionBody, PayeeReportBody } from "../api";
import { ApiError } from "../api";
import { MockGatewayApi, MockOperatorApi, addPlatformRefusals, seedPlatformRefusals } from "./gateway";
import { MockPayees, heavySignals } from "./payees";
import { DEMO_PAYEES } from "./payee-check";
import { MockAgentsApi, subscribeAgentEvents } from "./agents";
import { aggregateObligations, netTransfers, sumAmounts } from "../netting";
import type { ReaderSource } from "../near-reader";
import { MockPanic, demoHeight, mockReader } from "./rpc";
import { DEMO_DAO, DEMO_DAO_COUNCIL, MockDao, type SeedProposal } from "./dao";
import { DemoKeys, type MockRelayerDeps } from "./relayer";
import { demo } from "./scenario";
import { OPEN_BUDGET_STORAGE_YOCTO } from "../sign";
import type {
  Batch,
  BatchDetail,
  Call,
  Claim,
  Denial,
  EventType,
  Health,
  Info,
  LedgerEntry,
  BudgetDetail,
  BudgetRecord,
  NettingPreview,
  Payout,
  PayoutAccount,
  PayoutRun,
  Payouts,
  NetTransfer,
  NodeEvent,
  Overview,
  PayeeApproval,
  PayeeApprovals,
  PayeeReportFiled,
  PayeeReports,
  Provider,
  ReceiptProof,
  RevokeResult,
  SettlementResult,
  TrialBalance,
} from "../schemas";

const NETWORK: Network = "near:testnet";
const EMPTY = process.env.NEXT_PUBLIC_MOCK === "empty";
const EXPLORER = networkFor(NETWORK).explorer;
const USDC = 1_000_000n;

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261104);
let hashCounter = 0;
const hashOf = (label: string): Id32 => sha256Text(`${label}:${hashCounter++}`);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A NEAR transaction hash: 32 bytes in base58, as the explorer shows it. */
function txHashOf(label: string): string {
  let n = BigInt(`0x${hashOf(label)}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return out;
}
/** A display-only ed25519 key: base58 characters derived from the label. */
const agentKey = (label: string): PublicKey => `ed25519:${sha256Text(label).slice(0, 44).replace(/0/g, "z")}`;

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

const HUB: AccountId = "hub.payminto.testnet";
const TOKEN: AccountId = NEAR_TESTNET_USDC;
const OPERATOR: AccountId = "node.payminto.testnet";
const TREASURY_OWNER: AccountId = "treasury.testnet";
const TRADING_OWNER: AccountId = "trading-desk.testnet";
const TREASURY_AGENT = agentKey("treasury-agent");
const TRADING_AGENT = agentKey("trading-agent");
const WRITER_AGENT = agentKey("research-writer-agent");
const MARKET_DATA: AccountId = "market-data.testnet";
const RISK_SCAN: AccountId = "risk-scan.testnet";
const RESEARCH_WRITER: AccountId = "research-writer.testnet";
const UNLISTED: AccountId = "prompt-injection.testnet";

type MockBudget = BudgetRecord & { recentDenials: Denial[] };

const providers: Provider[] = [
  {
    id: "prv_market_data",
    name: "Market Data",
    description: "Spot quotes for NEAR and BTC with a deterministic fallback when the live source is down.",
    payee: MARKET_DATA,
    priceAtomic: (2000n).toString(),
    resource: "http://localhost:4101/quote",
    category: "Data",
    calls24h: 0,
  },
  {
    id: "prv_risk_scan",
    name: "Risk Scan",
    description: "Heuristic wallet risk score for any address, labelled as a heuristic.",
    payee: RISK_SCAN,
    priceAtomic: (10000n).toString(),
    resource: "http://localhost:4102/scan",
    category: "Compliance",
    calls24h: 0,
  },
  {
    id: "prv_research_writer",
    name: "Research Writer",
    description: "An agent that buys quotes and risk scans to write a short market brief.",
    payee: RESEARCH_WRITER,
    priceAtomic: (50000n).toString(),
    resource: "http://localhost:4103/brief",
    category: "Agent",
    calls24h: 0,
  },
];
if (EMPTY) providers.length = 0;
const priceOf = (payee: string) => BigInt(providers.find((p) => p.payee === payee)?.priceAtomic ?? "0");
const providerIdOf = (payee: string) => providers.find((p) => p.payee === payee)?.id ?? null;

// Anchored to the hour so ids (batch ids, call ids) are stable across reloads and deep links keep working.
const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => BigInt(Math.floor(ms / 1000));

function makeBudget(args: {
  key: string;
  label: string;
  owner: AccountId;
  agent: PublicKey;
  cap: bigint;
  policy: Policy;
  payees: AccountId[];
  createdMs: number;
  validDays: number;
  status?: BudgetRecord["status"];
  /** Escrow is funding, separate from the cap (decision 1); it may be below the cap. */
  escrow: bigint;
  /** The owner's withdrawable hub credit, earned by selling in settled batches. */
  ownerCredit?: bigint;
}): MockBudget {
  const validUntilMs = args.createdMs + args.validDays * 86_400_000;
  const terms = {
    owner: args.owner,
    agentPk: args.agent,
    settler: OPERATOR,
    cap: args.cap.toString(),
    validUntil: String(validUntilMs),
    payees: args.payees,
    policyHash: policyHash(args.policy),
    salt: sha256Text(`salt:${args.key}`),
  };
  return {
    id: sha256Text(`budget:${args.key}`),
    label: args.label,
    status: args.status ?? "open",
    budget: terms,
    owner: args.owner,
    agent: args.agent,
    settler: OPERATOR,
    cap: args.cap.toString(),
    expiresAt: iso(validUntilMs),
    policy: args.policy,
    payees: args.payees,
    spend: { settled: "0", pending: "0", today: "0", remaining: args.cap.toString() },
    openTxHash: txHashOf("open-tx"),
    revokedAt: args.status === "revoked" ? iso(args.createdMs + 3_600_000) : null,
    createdAt: iso(args.createdMs),
    escrow: args.escrow.toString(),
    ownerCredit: (args.ownerCredit ?? 0n).toString(),
    recentDenials: [],
  };
}

const budgets: MockBudget[] = [
  makeBudget({
    key: "treasury",
    label: "Treasury Agent - Q4 market research",
    owner: TREASURY_OWNER,
    agent: TREASURY_AGENT,
    cap: 8n * USDC,
    policy: { perCallCap: (100_000n).toString(), dailyCap: (4n * USDC).toString(), maxCallsPerMinute: 120, purpose: "Research agent for the Q4 market report" },
    payees: [MARKET_DATA, RISK_SCAN, RESEARCH_WRITER],
    createdMs: now - 3 * 86_400_000,
    validDays: 30,
    escrow: 5n * USDC,
  }),
  makeBudget({
    key: "trading",
    label: "Trading Agent - live quotes",
    owner: TRADING_OWNER,
    agent: TRADING_AGENT,
    cap: 2n * USDC,
    policy: { perCallCap: (20_000n).toString(), dailyCap: (1n * USDC).toString(), maxCallsPerMinute: 300, purpose: "Intraday quotes and counterparty checks" },
    payees: [MARKET_DATA, RISK_SCAN],
    createdMs: now - 2 * 86_400_000,
    validDays: 14,
    escrow: 2n * USDC,
  }),
  makeBudget({
    key: "writer",
    label: "Research Writer - sourcing",
    owner: RESEARCH_WRITER,
    agent: WRITER_AGENT,
    cap: 3n * USDC,
    policy: { perCallCap: (20_000n).toString(), dailyCap: (1_500_000n).toString(), maxCallsPerMinute: 120, purpose: "Buys inputs for paid research briefs" },
    payees: [MARKET_DATA, RISK_SCAN],
    createdMs: now - 2 * 86_400_000,
    validDays: 30,
    escrow: 900_000n,
    ownerCredit: 1_250_000n,
  }),
  makeBudget({
    key: "pilot",
    label: "Trading Agent - pilot",
    owner: TRADING_OWNER,
    agent: TRADING_AGENT,
    cap: 5n * USDC,
    policy: { perCallCap: (20_000n).toString(), dailyCap: (1n * USDC).toString(), maxCallsPerMinute: 60, purpose: "First week pilot, replaced by live quotes" },
    payees: [MARKET_DATA],
    createdMs: now - 6 * 86_400_000,
    validDays: 7,
    status: "revoked",
    escrow: 3n * USDC,
  }),
];

if (EMPTY) budgets.length = 0;

// ---------------------------------------------------------------------------
// Calls, denials, batches
// ---------------------------------------------------------------------------

type MockCall = Call & { timestampSec: bigint };
const calls: MockCall[] = [];
const denials: Denial[] = [];
const batches: BatchDetail[] = [];
const ledger: LedgerEntry[] = [];
const positions = new Map<string, bigint>(); // `${budgetId}:${payee}` -> cumulative accepted
const settledPos = new Map<string, bigint>(); // `${budgetId}:${payee}` -> cumulative settled
let journalSeq = 0;
let ledgerSeq = 0;

const mixes: { budget: MockBudget; weights: [AccountId, number][] }[] = [
  { budget: budgets[0]!, weights: [[MARKET_DATA, 0.5], [RISK_SCAN, 0.33], [RESEARCH_WRITER, 0.17]] },
  { budget: budgets[1]!, weights: [[MARKET_DATA, 0.8], [RISK_SCAN, 0.2]] },
  { budget: budgets[2]!, weights: [[MARKET_DATA, 0.6], [RISK_SCAN, 0.4]] },
];

function pick<T>(weights: [T, number][]): T {
  const r = rand();
  let acc = 0;
  for (const [v, w] of weights) {
    acc += w;
    if (r <= acc) return v;
  }
  return weights[weights.length - 1]![0];
}

function journal(at: string, memo: string, ref: string, lines: { account: string; debit?: bigint; credit?: bigint }[]) {
  const journalId = `j_${++journalSeq}`;
  for (const l of lines) {
    ledger.push({
      id: `le_${++ledgerSeq}`,
      journalId,
      account: l.account,
      debit: (l.debit ?? 0n).toString(),
      credit: (l.credit ?? 0n).toString(),
      memo,
      ref,
      createdAt: at,
    });
  }
}

function acceptCall(budget: MockBudget, payee: AccountId, atMs: number): MockCall {
  const key = `${budget.id}:${payee}`;
  const amount = priceOf(payee);
  const cumulative = (positions.get(key) ?? 0n) + amount;
  positions.set(key, cumulative);
  const call: MockCall = {
    id: hashOf("call"),
    budgetId: budget.id,
    agent: budget.agent,
    payee,
    providerId: providerIdOf(payee),
    amount: amount.toString(),
    cumulative: cumulative.toString(),
    requestHash: hashOf("req"),
    status: "accepted",
    batchId: null,
    createdAt: iso(atMs),
    timestampSec: sec(atMs),
  };
  calls.push(call);
  journal(call.createdAt, `Call accepted (${providers.find((p) => p.payee === payee)?.name ?? "provider"})`, call.id, [
    { account: `provider:${payee}:receivable`, debit: amount },
    { account: `owner:${ownerOf(call.budgetId)}:payable`, credit: amount },
  ]);
  return call;
}

/** The retry hint a node attaches for each rule (decision 8), as the mock imitates it. */
function retryFor(rule: DenialRule, shortBy: bigint): RetryHint {
  switch (rule) {
    case "RATE_LIMIT":
      return { kind: "after", seconds: 60 };
    case "DAILY_CAP":
      return { kind: "after", seconds: 6 * 3_600 };
    case "HOURLY_CAP":
      return { kind: "after", seconds: 1_800 };
    case "REPEAT_REQUEST":
      return { kind: "after", seconds: 1_500 };
    case "NET_EXPOSURE":
      return { kind: "fund", shortBy: shortBy.toString() };
    case "STALE_CUMULATIVE":
      return { kind: "resign", expectedCumulative: "0" };
    default:
      return { kind: "never" };
  }
}

function deny(rule: DenialRule, atMs: number, extra: Partial<Denial> & { shortBy?: bigint } = {}): Denial {
  const { shortBy = 0n, ...rest } = extra;
  const budget = budgets.find((b) => b.id === rest.budgetId);
  const remaining = budget ? BigInt(budget.cap) - calls.filter((c) => c.budgetId === budget.id).reduce((a, c) => a + BigInt(c.amount), 0n) : null;
  const refusal: Refusal = {
    rule,
    message: rest.message ?? DENIAL_RULES[rule],
    attemptedAmount: rest.amount ?? "0",
    remainingBudget: remaining === null ? null : (remaining < 0n ? 0n : remaining).toString(),
    retry: retryFor(rule, shortBy),
  };
  const credit = BigInt(budget?.ownerCredit ?? "0");
  if (rule === "NET_EXPOSURE" && budget && credit > 0n) {
    refusal.retry = { kind: "fund", shortBy: shortBy.toString(), fromCredit: { action: "fund_from_credit", budgetId: budget.id, amount: (shortBy < credit ? shortBy : credit).toString(), credit: credit.toString() } };
  }
  if (rule === "STALE_CUMULATIVE" && budget && rest.payee) refusal.retry = { kind: "resign", expectedCumulative: (positions.get(`${budget.id}:${rest.payee}`) ?? 0n).toString() };
  const d: Denial = {
    id: `dn_${denials.length + 1}`,
    rule,
    message: DENIAL_RULES[rule],
    createdAt: iso(atMs),
    details: { refusal },
    ...rest,
  };
  denials.unshift(d);
  return d;
}

const voucherSigOf = (callId: Id32): string => sha256Text(`sig:${callId}`) + sha256Text(`sig2:${callId}`);

const toFields = (c: MockCall): ReceiptFields => ({
  callId: c.id,
  budgetId: c.budgetId,
  payee: c.payee,
  amount: BigInt(c.amount),
  cumulative: BigInt(c.cumulative),
  requestHash: c.requestHash,
  timestampMs: c.timestampSec * 1000n,
  voucherSig: voucherSigOf(c.id),
});

const trees = new Map<string, ReceiptTree>();

/** Budget owners settle, so the owner (not the agent key) is the party that nets against what it earns. */
const ownerOf = (budgetId: string): AccountId => budgets.find((b) => b.id === budgetId)!.owner;

function settlePending(atMs: number): BatchDetail | null {
  const pending = calls.filter((c) => c.status === "accepted");
  if (pending.length === 0) return null;
  const seq = batches.length + 1;
  const batchId = sha256Text(`batch:${NETWORK}:${HUB}:${seq}`);
  const tree = buildReceiptTree(HUB, NETWORK, batchId, pending.map(toFields));

  // Latest voucher per (budget, payee) and its delta over what is already settled.
  const latest = new Map<string, MockCall>();
  const counts = new Map<string, number>();
  for (const c of pending) {
    const k = `${c.budgetId}:${c.payee}`;
    latest.set(k, c);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const claimList: Claim[] = [...latest.entries()].map(([k, c]) => {
    const prior = settledPos.get(k) ?? 0n;
    settledPos.set(k, BigInt(c.cumulative));
    return {
      budgetId: c.budgetId,
      agent: c.agent,
      payee: c.payee,
      cumulative: c.cumulative,
      previous: prior.toString(),
      delta: (BigInt(c.cumulative) - prior).toString(),
      calls: counts.get(k) ?? 0,
    };
  });
  const obligations = claimList.map((c) => ({ from: ownerOf(c.budgetId), to: c.payee, amount: c.delta }));
  const net = netTransfers(obligations);
  const txHash = txHashOf("settle-tx");
  const at = iso(atMs);
  const netTransfersOut: NetTransfer[] = net.map((t, i) => ({ ...t, index: i }));
  const gross = sumAmounts(obligations);
  const netTotal = sumAmounts(net);
  const entries = new Map<string, { debit: bigint; credit: bigint }>();
  for (const t of net) {
    const f = entries.get(t.from) ?? { debit: 0n, credit: 0n };
    f.debit += BigInt(t.amount);
    entries.set(t.from, f);
    const r = entries.get(t.to) ?? { debit: 0n, credit: 0n };
    r.credit += BigInt(t.amount);
    entries.set(t.to, r);
  }
  const batch: BatchDetail = {
    id: batchId,
    seq,
    status: "confirmed",
    receiptsRoot: tree.root,
    token: TOKEN,
    txHash,
    explorerUrl: explorerTx(NETWORK, txHash),
    gross: gross.toString(),
    net: netTotal.toString(),
    calls: pending.length,
    claims: claimList.length,
    transfers: net.length,
    error: null,
    createdAt: iso(atMs - 14_000),
    confirmedAt: at,
    claimList,
    netTransfers: netTransfersOut,
    netEntries: [...entries.entries()].map(([account, v]) => ({ account, debit: v.debit.toString(), credit: v.credit.toString() })),
  };
  batches.unshift(batch);
  trees.set(batchId, tree);
  for (const c of pending) {
    c.status = "settled";
    c.settledBy = "batch";
    c.batchId = batchId;
  }
  journal(at, `Batch #${seq} vouchers settled`, batchId, claimList.flatMap((c) => [
    { account: `owner:${ownerOf(c.budgetId)}:payable`, debit: BigInt(c.delta) },
    { account: `provider:${c.payee}:receivable`, credit: BigInt(c.delta) },
  ]));
  journal(at, `Batch #${seq} net transfers`, txHash, net.flatMap((t) => [
    { account: `${roleOf(t.to)}:${t.to}:wallet`, debit: BigInt(t.amount) },
    { account: `${roleOf(t.from)}:${t.from}:wallet`, credit: BigInt(t.amount) },
  ]));
  return batch;
}

function roleOf(address: string): "owner" | "provider" {
  return providers.some((p) => p.payee === address) ? "provider" : "owner";
}

function generateCalls(count: number, startMs: number, endMs: number) {
  const times = Array.from({ length: count }, () => startMs + rand() * (endMs - startMs)).sort((a, b) => a - b);
  for (const t of times) {
    const mix = pick<(typeof mixes)[number]>([[mixes[0]!, 0.3], [mixes[1]!, 0.36], [mixes[2]!, 0.34]]);
    acceptCall(mix.budget, pick(mix.weights), t);
  }
}

// NEXT_PUBLIC_MOCK=empty starts from a fresh node, which shows the first-run guide.
if (!EMPTY) {
  // History: batch 1 about 5 hours ago, batch 2 about 2 hours ago, then calls waiting to be netted.
  generateCalls(214, now - 9 * 3_600_000, now - 5 * 3_600_000);
  deny("PAYEE_NOT_ALLOWED", now - 6.2 * 3_600_000, { budgetId: budgets[0]!.id, agent: TREASURY_AGENT, payee: UNLISTED, amount: "250000", message: `${DENIAL_RULES.PAYEE_NOT_ALLOWED}. A tool result asked the agent to pay ${UNLISTED.slice(0, 10)}…` });
  settlePending(now - 5 * 3_600_000);
  generateCalls(178, now - 5 * 3_600_000 + 60_000, now - 2 * 3_600_000);
  deny("PER_CALL_CAP", now - 3.1 * 3_600_000, { budgetId: budgets[1]!.id, agent: TRADING_AGENT, payee: RISK_SCAN, providerId: "prv_risk_scan", amount: "500000", message: `${DENIAL_RULES.PER_CALL_CAP}: 0.50 USDC asked, cap is 0.02 USDC` });
  deny("STALE_CUMULATIVE", now - 2.8 * 3_600_000, { budgetId: budgets[1]!.id, agent: TRADING_AGENT, payee: MARKET_DATA, providerId: "prv_market_data", amount: "2000" });
  settlePending(now - 2 * 3_600_000);
  generateCalls(138, now - 2 * 3_600_000 + 60_000, now - 90_000);
  deny("PAYEE_NOT_ALLOWED", now - 50 * 60_000, { budgetId: budgets[0]!.id, agent: TREASURY_AGENT, payee: UNLISTED, amount: "1000000", message: `${DENIAL_RULES.PAYEE_NOT_ALLOWED}. A scraped page asked the agent to pay ${UNLISTED.slice(0, 10)}…` });
  deny("PER_CALL_CAP", now - 34 * 60_000, { budgetId: budgets[2]!.id, agent: WRITER_AGENT, payee: RISK_SCAN, providerId: "prv_risk_scan", amount: "40000", message: `${DENIAL_RULES.PER_CALL_CAP}: 0.04 USDC asked, cap is 0.02 USDC` });
  deny("RATE_LIMIT", now - 21 * 60_000, { budgetId: budgets[1]!.id, agent: TRADING_AGENT, payee: MARKET_DATA, providerId: "prv_market_data", amount: "2000" });
  deny("BUDGET_REVOKED", now - 12 * 60_000, { budgetId: budgets[3]!.id, agent: TRADING_AGENT, payee: MARKET_DATA, providerId: "prv_market_data", amount: "2000" });
  // Escrow only counts toward exposure: the writer earned credit by selling, but it sits outside this Budget until moved.
  deny("NET_EXPOSURE", now - 6 * 60_000, { budgetId: budgets[2]!.id, agent: WRITER_AGENT, payee: RISK_SCAN, providerId: "prv_risk_scan", amount: "10000", shortBy: 400_000n });
  // Two Refusals a current server words differently from before, appended so the ids above stay what they were. A
  // rolling limit answers with the real wait, and the server refuses when it cannot read a Budget's escrow from the hub,
  // which says nothing about the Budget.
  deny("REPEAT_REQUEST", now - 5 * 60_000, { budgetId: budgets[0]!.id, agent: TREASURY_AGENT, payee: MARKET_DATA, providerId: "prv_market_data", amount: "2000" });
  const unread = deny("NET_EXPOSURE", now - 3 * 60_000, { budgetId: budgets[1]!.id, agent: TRADING_AGENT, payee: MARKET_DATA, providerId: "prv_market_data", amount: "2000", message: HUB_UNREADABLE_MESSAGE });
  (unread.details!.refusal as Refusal).retry = { kind: "after", seconds: 5, reason: "hub_unreadable" };
  seedPlatformRefusals(denials.map(refusalObject));
}

/** The `budget.refused` webhook object for a refusal, as the node sends it to platform alert endpoints. */
function refusalObject(d: Denial): BudgetRefusal {
  const r = (d.details?.refusal ?? null) as Refusal | null;
  const b = budgets.find((x) => x.id === d.budgetId);
  return {
    id: d.id,
    object: "refusal",
    rule: d.rule,
    message: d.message,
    budget_id: d.budgetId ?? "",
    owner: b?.owner ?? null,
    agent: d.agent ?? null,
    payee: d.payee ?? "",
    provider_id: d.providerId ?? "",
    attempted_amount: r?.attemptedAmount ?? d.amount ?? "0",
    remaining_budget: r?.remainingBudget ?? null,
    retry: r?.retry ?? { kind: "never" },
    request_hash: sha256Text(`request:${d.id}`),
    cumulative: d.amount ?? "0",
    created_at: d.createdAt,
  };
}

// ---------------------------------------------------------------------------
// The demo wallet: owner transactions applied to this in-memory hub. Simulated, and labeled so in the UI.
// ---------------------------------------------------------------------------

/**
 * One Budget owned by a Sputnik DAO, so the Proposals panel can be seen with no chain. Its id is the real hash of its
 * terms, because an `open_budget` proposal is matched to a Budget by recomputing that hash. Created after the call
 * fixtures so their ids stay what they were.
 */
const OPS_AGENT = keypairFromSeed(id32Bytes(sha256Text("payminto demo agent key, not a real key: ops"))).publicKey;
const daoBudget = makeBudget({
  key: "dao-ops",
  label: "Ops Agent - DAO treasury",
  owner: DEMO_DAO,
  agent: OPS_AGENT,
  cap: 60n * USDC,
  policy: { perCallCap: (50_000n).toString(), dailyCap: (6n * USDC).toString(), maxCallsPerMinute: 60, purpose: "Operations agent paid from the DAO treasury" },
  payees: [MARKET_DATA, RISK_SCAN],
  createdMs: now - 10 * 86_400_000,
  validDays: 40,
  escrow: 10n * USDC,
  ownerCredit: 1_250_000n,
});
daoBudget.id = budgetIdOf(HUB, NETWORK, budgetTermsFromJson(daoBudget.budget as BudgetTermsJson));
if (!EMPTY) budgets.push(daoBudget);

/** Budgets open on the demo hub, and escrow deposited before this server registered them. */
const openedOnChain = new Map<Id32, { owner: AccountId; cap: string }>(budgets.map((b) => [b.id, { owner: b.owner, cap: b.cap }]));
const pendingEscrow = new Map<Id32, bigint>();

export type MockTxOutcome = { ok: true; used?: bigint } | { ok: false; error: string; refunded?: boolean };

const sameOwner = (owner: AccountId) => budgets.filter((b) => b.owner === owner);

/** Applies one wallet transaction as the hub would, so owner flows can be walked through without a chain. */
export function applyMockWalletTx(tx: WalletTx, signer: AccountId): MockTxOutcome {
  const call = tx.actions[0];
  if (!call) return { ok: false, error: "The transaction has no action." };
  const { methodName, args } = call.params;
  const budgetOf = (id: unknown) => budgets.find((b) => b.id === id);
  switch (methodName) {
    case "ft_transfer_call": {
      if (tx.receiverId !== TOKEN || args.receiver_id !== HUB) return { ok: false, error: "Smart contract panicked: unknown receiver", refunded: true };
      const msg = JSON.parse(String(args.msg)) as { budget?: { budget_id: string } };
      const b = budgetOf(msg.budget?.budget_id);
      const amount = BigInt(String(args.amount));
      // Opened on the demo hub moments ago and not yet registered with this server: hold the escrow for it.
      if (!b && msg.budget && openedOnChain.has(msg.budget.budget_id)) {
        pendingEscrow.set(msg.budget.budget_id, (pendingEscrow.get(msg.budget.budget_id) ?? 0n) + amount);
        return { ok: true, used: amount };
      }
      if (!b) return { ok: false, error: "Smart contract panicked: UNKNOWN_BUDGET", refunded: true };
      if (b.status !== "open" && b.status !== "pending") return { ok: false, error: "Smart contract panicked: BUDGET_CLOSED", refunded: true };
      b.escrow = (BigInt(b.escrow ?? "0") + amount).toString();
      return { ok: true, used: amount };
    }
    case "open_budget": {
      const t = args.terms as { agent_pk: string; settler: string; cap: string; valid_until: string; payees: string[]; policy_hash: string; salt: string };
      const pk = new Uint8Array(t.agent_pk.match(/../g)!.map((h) => parseInt(h, 16)));
      const id = budgetIdOf(HUB, NETWORK, { owner: signer, agentPk: publicKeyToString(pk), settler: t.settler, cap: BigInt(t.cap), validUntil: BigInt(t.valid_until), payees: t.payees, policyHash: t.policy_hash, salt: t.salt });
      if (budgetOf(id) || openedOnChain.has(id)) return { ok: false, error: "Smart contract panicked: BUDGET_EXISTS" };
      openedOnChain.set(id, { owner: signer, cap: t.cap });
      return { ok: true };
    }
    case "fund_from_credit": {
      const b = budgetOf(args.budget_id);
      if (!b) return { ok: false, error: "Smart contract panicked: UNKNOWN_BUDGET" };
      if (b.owner !== signer) return { ok: false, error: "Smart contract panicked: NOT_OWNER" };
      const amount = BigInt(String(args.amount));
      const credit = BigInt(b.ownerCredit ?? "0");
      if (amount > credit) return { ok: false, error: "Smart contract panicked: INSUFFICIENT_CREDIT" };
      for (const o of sameOwner(b.owner)) o.ownerCredit = (credit - amount).toString();
      b.escrow = (BigInt(b.escrow ?? "0") + amount).toString();
      return { ok: true };
    }
    case "revoke_budget": {
      const b = budgetOf(args.budget_id);
      if (!b) return { ok: false, error: "Smart contract panicked: UNKNOWN_BUDGET" };
      if (b.owner !== signer) return { ok: false, error: "Smart contract panicked: NOT_OWNER" };
      if (b.status === "revoked") return { ok: false, error: "Smart contract panicked: ALREADY_REVOKED" };
      b.status = "revoked";
      b.revokedAt = new Date().toISOString();
      emit("budget.revoked", budgetView(b) as unknown as Record<string, unknown>);
      return { ok: true };
    }
    case "reclaim": {
      const b = budgetOf(args.budget_id);
      if (!b) return { ok: false, error: "Smart contract panicked: UNKNOWN_BUDGET" };
      if (b.owner !== signer) return { ok: false, error: "Smart contract panicked: NOT_OWNER" };
      b.escrow = "0";
      return { ok: true };
    }
    default:
      return { ok: false, error: `Smart contract panicked: the demo hub does not run ${methodName}` };
  }
}

// ---------------------------------------------------------------------------
// The demo DAO, the demo wallet's keys and the demo relayer's view of this hub. Simulated, and labeled so in the UI.
// ---------------------------------------------------------------------------

/** The demo DAO's proposals: one approved (it opened the Budget) and one waiting for a second approval. */
function seedDaoProposals(addon: Parameters<ConstructorParameters<typeof MockDao>[0]["seed"]>[0]): SeedProposal[] {
  if (EMPTY) return [];
  const ctx = { dao: DEMO_DAO, hub: HUB, network: NETWORK, proposalBond: demoDao.policy.proposal_bond };
  const [first, second, third] = DEMO_DAO_COUNCIL as [AccountId, AccountId, AccountId];
  const seeds: SeedProposal[] = [
    {
      ...addon.openBudgetProposal(ctx, budgetTermsFromJson(daoBudget.budget as BudgetTermsJson), OPEN_BUDGET_STORAGE_YOCTO).proposal,
      proposer: first,
      status: "Approved",
      votes: { [first]: "Approve", [second]: "Approve" },
      submittedMs: now - 10 * 86_400_000,
    },
  ];
  if (demo("dao-edge")) {
    seeds.push(
      { ...addon.depositProposal(ctx, TOKEN, daoBudget.id, 10n * USDC).proposal, proposer: third, status: "InProgress", votes: { [third]: "Approve" }, submittedMs: now - 8 * 86_400_000 },
      {
        description: "Pay the design contractor from the treasury",
        kind: addon.functionCallKind({ receiverId: TOKEN, actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: "design-contractor.testnet", amount: (40n * USDC).toString() }, gas: "30000000000000", deposit: "1" } }] }),
        proposer: third,
        status: "InProgress",
        votes: {},
        submittedMs: now - 3 * 3_600_000,
      },
    );
  }
  seeds.push({ ...addon.depositProposal(ctx, TOKEN, daoBudget.id, 25n * USDC).proposal, proposer: second, status: "InProgress", votes: { [second]: "Approve" }, submittedMs: now - 40 * 60_000 });
  return seeds;
}

export const demoDao = new MockDao({ run: (tx, signer) => applyMockWalletTx(tx, signer), seed: seedDaoProposals });

/** Transactions members sign on the demo DAO; null for anything addressed elsewhere. */
export const applyMockDaoTx = (tx: WalletTx, signer: AccountId) => demoDao.apply(tx, signer);

export const demoKeys = new DemoKeys();

/** Transactions the demo relayer sent: when the demo chain reports them final, or the hub's panic. */
const relayed = new Map<string, { finalAtMs: number; failure: string | null }>();

export const mockRelayerDeps: MockRelayerDeps = {
  hub: HUB,
  network: NETWORK,
  keys: demoKeys,
  height: demoHeight,
  run: (tx, signer) => applyMockWalletTx(tx, signer),
  record: (hash, o) => void relayed.set(hash, o),
  hash: () => txHashOf("relayed-tx"),
};

// ---------------------------------------------------------------------------
// Calls a seller settled itself on the hub (`settle_own`), booked by the server outside any batch: settled, with no
// Merkle proof. Added after every other fixture, and with ids of its own, so the ids above stay what they were.
// ---------------------------------------------------------------------------

type MockSellerSettlement = {
  id: string;
  budgetId: Id32;
  payee: AccountId;
  /** The settled position before and after, atomic units. */
  previous: string;
  cumulative: string;
  amount: string;
  uncleared: string;
  calls: number;
  detectedAt: string;
};
const sellerSettlements: MockSellerSettlement[] = [];
/** Call id to the seller settlement that settled it. */
const sellerSettledCalls = new Map<Id32, MockSellerSettlement>();
/** The key the demo server signs receipts with, as `/v1/info` reports it; the demo hub holds it as the server's receipt key. */
const NODE_KEY = agentKey("node-key");

/**
 * Books what a seller settled itself, as the server does when it finds the hub's settled position ahead of its own:
 * every accepted Call of the pair up to the settled voucher becomes settled, in no batch. `voucherAtMs` is when the
 * seller's latest voucher was accepted; Calls accepted after it still wait for the next settlement.
 */
function bookSellerSettlement(budget: MockBudget, payee: AccountId, voucherAtMs: number, detectedAtMs: number): MockSellerSettlement | null {
  const key = `${budget.id}:${payee}`;
  const covered = calls.filter((c) => c.budgetId === budget.id && c.payee === payee && c.status === "accepted" && new Date(c.createdAt).getTime() <= voucherAtMs);
  const last = covered[covered.length - 1];
  if (!last) return null;
  const previous = settledPos.get(key) ?? 0n;
  const cumulative = BigInt(last.cumulative);
  const delta = cumulative - previous;
  const s: MockSellerSettlement = {
    id: `sst_${sha256Text(`seller-settlement:${key}:${cumulative}`).slice(0, 16)}`,
    budgetId: budget.id,
    payee,
    previous: previous.toString(),
    cumulative: cumulative.toString(),
    amount: delta.toString(),
    uncleared: "0",
    calls: covered.length,
    detectedAt: iso(detectedAtMs),
  };
  settledPos.set(key, cumulative);
  for (const c of covered) {
    c.status = "settled";
    c.settledBy = "seller";
    sellerSettledCalls.set(c.id, s);
  }
  sellerSettlements.push(s);
  // As the hub did: the amount left the owner's escrow for the seller's hub credit, and the accrual between them is cleared.
  journal(s.detectedAt, `Settled by the seller on the hub (${providers.find((p) => p.payee === payee)?.name ?? "seller"})`, s.id, [
    { account: `owner:${budget.owner}:payable`, debit: delta },
    { account: `provider:${payee}:receivable`, credit: delta },
    { account: `${roleOf(payee)}:${payee}:wallet`, debit: delta },
    { account: `owner:${budget.owner}:wallet`, credit: delta },
  ]);
  return s;
}

/** The `seller.settled` event payload, in the server's shape. */
const sellerSettlementJson = (s: MockSellerSettlement) => ({ id: s.id, budgetId: s.budgetId, payee: s.payee, previous: s.previous, cumulative: s.cumulative, amount: s.amount, uncleared: s.uncleared, calls: s.calls });

if (!EMPTY) {
  // Research Writer settled its own voucher from the Treasury Budget on the hub; the server found and booked it a minute ago.
  bookSellerSettlement(budgets[0]!, RESEARCH_WRITER, now - 25 * 60_000, now - 60_000);
}

// ---------------------------------------------------------------------------
// The payee check, as the node runs it (lib/mock/payees.ts). One Budget shows every state an owner meets: a Call that
// waits for approval, a Payee approved earlier, a Payee the check blocks, and a Payee with one report against it.
// Created after every other fixture, so their ids stay what they were.
// ---------------------------------------------------------------------------

const VENDOR_OWNER: AccountId = "procurement.testnet";
const VENDOR_AGENT = agentKey("vendor-agent");
const VENDOR_WAITING = DEMO_PAYEES.unregistered;
const VENDOR_BLOCKED = DEMO_PAYEES.reported;
const VENDOR_REPORTED = DEMO_PAYEES.reportedOnce;
const VENDOR_PRICE = 40_000n;
const vendorBudget = makeBudget({
  key: "vendors",
  label: "Vendor Agent - supplier payments",
  owner: VENDOR_OWNER,
  agent: VENDOR_AGENT,
  cap: 20n * USDC,
  policy: { perCallCap: (100_000n).toString(), dailyCap: (5n * USDC).toString(), maxCallsPerMinute: 30, purpose: "Pays the suppliers the procurement team has listed" },
  payees: [MARKET_DATA, RESEARCH_WRITER, VENDOR_WAITING, VENDOR_REPORTED, VENDOR_BLOCKED],
  createdMs: now - 20 * 3_600_000,
  validDays: 30,
  escrow: 6n * USDC,
});

const payeeService = new MockPayees({
  token: TOKEN,
  operator: OPERATOR,
  dashboardUrl: typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
  budgets: () => budgets,
  history: (payer, payee) => {
    const paid = calls.filter((c) => c.payee === payee && budgets.find((b) => b.id === c.budgetId)?.owner === payer);
    const last = paid[paid.length - 1];
    return { count: paid.length, total: paid.reduce((a, c) => a + BigInt(c.amount), 0n), lastAtMs: last ? new Date(last.createdAt).getTime() : null };
  },
  emit: (type, data) => emit(type, data),
  off: () => demo("payee-check-off"),
  latencyMs: process.env.NODE_ENV === "test" ? 0 : 320,
});

/** A refusal the payee check made, worded and detailed as the node records it. */
function payeeRefusal(rule: "PAYEE_BLOCKED" | "PAYEE_NEEDS_APPROVAL", payee: AccountId, atMs: number): Denial {
  const d = deny(rule, atMs, { budgetId: vendorBudget.id, agent: VENDOR_AGENT, payee, amount: VENDOR_PRICE.toString() });
  if (rule === "PAYEE_NEEDS_APPROVAL") (d.details!.refusal as Refusal).retry = { kind: "approval", payee, approveAt: payeeService.approveAt(vendorBudget.id) };
  return d;
}

/** Fills in what the check found, once it has looked: the signals behind each seeded refusal, and the request that waits. */
function describePayeeRefusal(d: Denial): void {
  const v = payeeService.held(vendorBudget.id, d.payee!);
  if (!v || !d.details) return;
  const signals = heavySignals(v);
  const refusal = d.details.refusal as Refusal;
  const waiting = d.rule === "PAYEE_NEEDS_APPROVAL";
  const top = signals.find((s) => s.severity === (waiting ? "warn" : "block"));
  d.message = waiting ? `${DENIAL_RULES.PAYEE_NEEDS_APPROVAL}: ${signals.filter((s) => s.severity === "warn").map((s) => s.id).join(", ")}` : `${DENIAL_RULES.PAYEE_BLOCKED}: ${top ? `${top.id} (${top.reason})` : "blocked"}`;
  refusal.message = d.message;
  d.details.payee = d.payee;
  d.details.payeeCheck = { verdict: v.verdict, basis: "fresh", checkedAtMs: v.checkedAtMs, complete: true, signals };
  if (waiting) {
    const approveAt = payeeService.approveAt(vendorBudget.id);
    const request = payeeService.approvals(vendorBudget.id).waiting.find((r) => r.payee === d.payee);
    d.details.approval = { status: "waiting", approveAt, requestId: request?.id ?? null, newSignals: signals.filter((s) => s.severity === "warn").map((s) => s.id) };
  }
}

const seededPayeeRefusals: Denial[] = [];
if (!EMPTY) {
  budgets.push(vendorBudget);
  openedOnChain.set(vendorBudget.id, { owner: vendorBudget.owner, cap: vendorBudget.cap });
  seededPayeeRefusals.push(payeeRefusal("PAYEE_BLOCKED", VENDOR_BLOCKED, now - 26 * 60_000), payeeRefusal("PAYEE_NEEDS_APPROVAL", VENDOR_WAITING, now - 14 * 60_000), payeeRefusal("PAYEE_NEEDS_APPROVAL", VENDOR_WAITING, now - 2 * 60_000));
  // Newest first, as every other refusal already is.
  denials.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  addPlatformRefusals(seededPayeeRefusals.map(refusalObject));
}

/** Resolves once the demo node has judged every listed Payee and holds the Vendor Budget's approval and waiting Call. */
function payeesReady(): Promise<void> {
  return payeeService.ready((p) => {
    if (EMPTY) return;
    p.seedApproval(vendorBudget, RESEARCH_WRITER, { decision: "approve", note: "Confirmed with the writer by phone on Monday.", decidedBy: { type: "user", id: "usr_padmin" }, at: now - 19 * 3_600_000 });
    p.wait(vendorBudget, VENDOR_WAITING, VENDOR_PRICE, now - 14 * 60_000);
    p.wait(vendorBudget, VENDOR_WAITING, VENDOR_PRICE, now - 2 * 60_000);
    for (const d of seededPayeeRefusals) describePayeeRefusal(d);
  });
}

/** The Vendor Agent tries a listed Payee that has a report against it: the Call is refused, and a request arrives live. */
function vendorTriesReportedPayee(): void {
  void payeesReady().then(() => {
    if (demo("payee-check-off")) return;
    const d = payeeRefusal("PAYEE_NEEDS_APPROVAL", VENDOR_REPORTED, Date.now());
    payeeService.wait(vendorBudget, VENDOR_REPORTED, VENDOR_PRICE);
    describePayeeRefusal(d);
    emit("call.denied", d as unknown as Record<string, unknown>);
  });
}

/** The demo user who is signed in, as the node names whoever decides or files a report. */
const DEMO_ACTOR = { type: "user", id: "usr_owner" };

/** Demo switches that play a live event a few seconds after the first screen subscribes. Each plays once per page load. */
let demoEventsPlayed = false;
function playDemoEvents() {
  if (EMPTY || demoEventsPlayed || typeof window === "undefined") return;
  demoEventsPlayed = true;
  if (demo("operator-alert")) {
    setTimeout(() => {
      const s = sellerSettlements[0];
      emit("operator.alert", {
        alert: {
          kind: "seller_settled_uncleared",
          message: "a payee settled a voucher on the hub that this node never accepted",
          sellerSettlement: s?.id ?? "sst_demo",
          budgetId: budgets[2]!.id,
          payee: RISK_SCAN,
          uncleared: "40000",
          hubSettled: ((settledPos.get(`${budgets[2]!.id}:${RISK_SCAN}`) ?? 0n) + 40_000n).toString(),
        },
      });
    }, 3_000);
  }
  if (demo("payee-request-arrives")) setTimeout(vendorTriesReportedPayee, 6_000);
  if (demo("seller-settles")) {
    setTimeout(() => {
      const s = bookSellerSettlement(budgets[1]!, MARKET_DATA, Date.now(), Date.now());
      if (s) emit("seller.settled", { sellerSettlement: sellerSettlementJson(s) });
    }, 6_000);
  }
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

function spendOf(m: MockBudget) {
  let settled = 0n;
  let pending = 0n;
  let today = 0n;
  const dayAgo = Date.now() - 86_400_000;
  for (const c of calls) {
    if (c.budgetId !== m.id) continue;
    const a = BigInt(c.amount);
    if (c.status === "settled") settled += a;
    else pending += a;
    if (new Date(c.createdAt).getTime() >= dayAgo) today += a;
  }
  const remaining = BigInt(m.cap) - settled - pending;
  return { settled: settled.toString(), pending: pending.toString(), today: today.toString(), remaining: (remaining < 0n ? 0n : remaining).toString() };
}

function budgetView(m: MockBudget): BudgetRecord {
  const { recentDenials: _d, ...rest } = m;
  void _d;
  return { ...rest, spend: spendOf(m) };
}

function batchSummary(b: BatchDetail): Batch {
  const { claimList: _c, netTransfers: _n, netEntries: _e, ...rest } = b;
  void _c;
  void _n;
  void _e;
  return rest;
}

function preview(): NettingPreview {
  const pending = calls.filter((c) => c.status === "accepted");
  const gross = aggregateObligations(pending.map((c) => ({ from: ownerOf(c.budgetId), to: c.payee, amount: c.amount, calls: 1 })));
  const net = netTransfers(gross);
  return {
    token: TOKEN,
    gross,
    net,
    grossTotal: sumAmounts(gross).toString(),
    netTotal: sumAmounts(net).toString(),
    calls: pending.length,
    compression: net.length ? pending.length / net.length : 0,
  };
}

const delay = (ms = 220 + Math.round(rand() * 260)) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Live traffic and events
// ---------------------------------------------------------------------------

type Listener = (e: NodeEvent) => void;
const listeners = new Set<Listener>();
let eventSeq = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
let settling = false;

function emit(type: EventType, data: Record<string, unknown>) {
  const e: NodeEvent = { type, id: `ev_${++eventSeq}`, at: new Date().toISOString(), data };
  for (const l of listeners) l(e);
}

function tick() {
  if (settling) return;
  const r = rand();
  if (r < 0.04) {
    const d = deny("PAYEE_NOT_ALLOWED", Date.now(), { budgetId: budgets[0]!.id, agent: TREASURY_AGENT, payee: UNLISTED, amount: "250000" });
    emit("call.denied", d as unknown as Record<string, unknown>);
    return;
  }
  const mix = pick<(typeof mixes)[number]>([[mixes[0]!, 0.3], [mixes[1]!, 0.36], [mixes[2]!, 0.34]]);
  const c = acceptCall(mix.budget, pick(mix.weights), Date.now());
  const { timestampSec: _t, ...wire } = c;
  void _t;
  emit("call.accepted", wire);
}

function startTraffic() {
  if (EMPTY || ticker || typeof window === "undefined") return;
  ticker = setInterval(tick, 2600);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Payouts: hub credit of net creditors, paid out to their own accounts. One Payee is not registered with the token, so
// its credit waits on the hub, as on testnet.
// ---------------------------------------------------------------------------

const UNREGISTERED = new Set<AccountId>([RISK_SCAN]);
const payoutRuns: Payout[] = [];
const paidOut = new Map<AccountId, bigint>();

function creditOf(account: AccountId): bigint {
  let credit = 0n;
  for (const b of batches) for (const e of b.netEntries ?? []) if (e.account === account) credit += BigInt(e.credit);
  return credit - (paidOut.get(account) ?? 0n);
}

function payoutAccounts(): PayoutAccount[] {
  const accounts = [...new Set(batches.flatMap((b) => (b.netEntries ?? []).filter((e) => BigInt(e.credit) > 0n).map((e) => e.account)))].sort();
  return accounts.map((account) => {
    const credit = creditOf(account);
    const status: PayoutAccount["status"] = credit === 0n ? "clear" : UNREGISTERED.has(account) ? "waiting_registration" : "due";
    return { account, status, credit: credit.toString(), paidTotal: (paidOut.get(account) ?? 0n).toString(), attempts: status === "waiting_registration" ? 2 : 0, nextAttemptAt: status === "clear" ? null : iso(Date.now() + 30 * 60_000), lastError: status === "waiting_registration" ? "The account is not registered with the token (storage_deposit), so the hub keeps its credit." : null, checkedAt: iso(Date.now() - 60_000) };
  });
}

function settlementCsv(range: { from?: string; to?: string; account?: string }): string {
  const from = range.from ? Date.parse(range.from) : 0;
  const to = range.to ? Date.parse(range.to) : Date.now() + 1000;
  const rows = [["batch_seq", "batch_id", "confirmed_at", "tx_hash", "account", "gross_paid", "gross_received", "net_debit", "net_credit"]];
  for (const b of [...batches].reverse()) {
    const at = Date.parse(b.confirmedAt ?? b.createdAt);
    if (at < from || at >= to) continue;
    const gross = new Map<string, { paid: bigint; received: bigint }>();
    for (const c of b.claimList) {
      const owner = ownerOf(c.budgetId);
      const g = gross.get(owner) ?? { paid: 0n, received: 0n };
      g.paid += BigInt(c.delta);
      gross.set(owner, g);
      const r = gross.get(c.payee) ?? { paid: 0n, received: 0n };
      r.received += BigInt(c.delta);
      gross.set(c.payee, r);
    }
    for (const [account, g] of [...gross.entries()].sort()) {
      if (range.account && account !== range.account) continue;
      const e = (b.netEntries ?? []).find((x) => x.account === account);
      rows.push([String(b.seq), b.id, b.confirmedAt ?? "", b.txHash ?? "", account, g.paid.toString(), g.received.toString(), e?.debit ?? "0", e?.credit ?? "0"]);
    }
  }
  return `${rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")}\n`;
}

/** What the demo hub's views return, from the same state the mock node settles into. */
function hubView(method: string, args: Record<string, unknown>): unknown {
  switch (method) {
    case "budget": {
      const id = String(args.budget_id);
      const b = budgets.find((x) => x.id === id);
      const opened = openedOnChain.get(id);
      if (!opened) return null;
      return { owner: opened.owner, settler: OPERATOR, cap: opened.cap, spent: b ? spendOf(b).settled : "0", escrow: b?.escrow ?? (pendingEscrow.get(id) ?? 0n).toString(), revoked_at: b?.revokedAt ? String(new Date(b.revokedAt).getTime()) : null };
    }
    case "credit_of":
      // What the demo hub owes an account: its credit from settled batches, less what payouts sent.
      return creditOf(String(args.account)).toString();
    case "batch": {
      const b = batches.find((x) => x.id === args.batch_id && x.status === "confirmed");
      if (!b || !b.receiptsRoot) return null;
      return { root: b.receiptsRoot, settler: OPERATOR, gross: b.gross, net: b.net, at: String(new Date(b.confirmedAt ?? b.createdAt).getTime()) };
    }
    // What a (Budget, Payee) pair has settled on the hub, by a batch or by the seller itself.
    case "settled_of":
      return (settledPos.get(`${String(args.budget_id)}:${String(args.payee)}`) ?? 0n).toString();
    // The receipt keys a settler registered, as 32 bytes of hex. `?demo=hub-not-ready` shows a server that registered none.
    case "receipt_keys":
      return args.settler === OPERATOR && !demo("hub-not-ready") ? [toHex(publicKeyBytes(NODE_KEY))] : [];
    // Unused prepaid storage in yoctoNEAR: 1 NEAR for the demo server, or 0.12 NEAR under `?demo=hub-not-ready`.
    case "storage_of":
      return (args.account === OPERATOR ? (demo("hub-not-ready") ? 12n * 10n ** 22n : 10n ** 24n) : 0n).toString();
    case "verify_receipt": {
      const batchId = String(args.batch_id);
      const tree = trees.get(batchId);
      if (!tree) return false;
      const f = args.fields as Record<string, string>;
      const leaf = receiptLeaf(HUB, NETWORK, batchId, {
        callId: f.call_id!,
        budgetId: f.budget_id!,
        payee: f.payee!,
        amount: BigInt(f.amount!),
        cumulative: BigInt(f.cumulative!),
        requestHash: f.request_hash!,
        timestampMs: BigInt(f.timestamp_ms!),
        voucherSig: f.voucher_sig!,
      });
      return verifyMerkleProof(tree.root, leaf, args.proof as Id32[]);
    }
    default:
      throw new MockPanic(`MethodResolveError(MethodNotFound) ${method}`);
  }
}

let demoReader: ReaderSource | null = null;

/** The demo chain: this hub, the demo DAO, the demo wallet's keys and the relayer's transactions, behind one JSON-RPC. */
export function demoSource(): ReaderSource {
  demoReader ??= mockReader({
    hub: HUB,
    view: hubView,
    contract: (account) => (account === DEMO_DAO ? demoDao.view : null),
    accessKey: (account, publicKey) => demoKeys.nonce(account, publicKey),
    txFinal: (hash) => batches.some((b) => b.txHash === hash) || (relayed.get(hash)?.failure === null && relayed.get(hash)!.finalAtMs <= Date.now()),
    txFailure: (hash) => {
      const r = relayed.get(hash);
      return r && r.failure !== null && r.finalAtMs <= Date.now() ? r.failure : null;
    },
  });
  return demoReader;
}

export class MockClearingApi implements ClearingApi {
  readonly mock = true;
  readonly nodeUrl = "mock://clearing-node";
  readonly gateway = new MockGatewayApi();
  readonly platformWebhooks = new MockGatewayApi("platform");
  readonly operator = new MockOperatorApi();
  readonly agents = new MockAgentsApi();
  readonly role = "operator" as const;

  async health(): Promise<Health> {
    await delay(80);
    return { ok: true, network: NETWORK, hub: HUB, token: TOKEN, operator: OPERATOR };
  }

  nearReader(): ReaderSource {
    return demoSource();
  }

  async info(): Promise<Info> {
    await delay();
    return {
      network: { id: NETWORK, name: networkFor(NETWORK).name, explorer: EXPLORER, testnet: true, rpc_url: networkFor(NETWORK).rpcUrl },
      hub: HUB,
      token: { address: TOKEN, symbol: "USDC", decimals: 6 },
      explorer: EXPLORER,
      operator: OPERATOR,
      nodeKey: agentKey("node-key"),
      version: "0.1.0-mock",
      settleIntervalSec: 0,
      publicUrl: "http://localhost:8787",
    };
  }

  async overview(): Promise<Overview> {
    await delay();
    const dayAgo = Date.now() - 86_400_000;
    const settled = calls.filter((c) => c.status === "settled");
    const pending = calls.filter((c) => c.status === "accepted");
    const transfers = batches.reduce((a, b) => a + b.transfers, 0);
    return {
      volume: { settled: sumAmounts(settled).toString(), pending: sumAmounts(pending).toString() },
      calls: { last24h: calls.filter((c) => new Date(c.createdAt).getTime() >= dayAgo).length, all: calls.length },
      denials24h: denials.filter((d) => new Date(d.createdAt).getTime() >= dayAgo).length,
      activeBudgets: budgets.filter((m) => m.status === "open").length,
      providers: providers.length,
      batches: batches.length,
      // Calls settled in batches per transfer; a Call its seller settled itself is in no batch and moved no net transfer.
      compressionRatio: transfers ? settled.filter((c) => c.batchId).length / transfers : 0,
      lastBatch: batches[0] ? batchSummary(batches[0]) : null,
      settled: { gross: batches.reduce((a, b) => a + BigInt(b.gross), 0n).toString(), net: batches.reduce((a, b) => a + BigInt(b.net), 0n).toString() },
      settledBySeller: {
        gross: sellerSettlements.reduce((a, s) => a + BigInt(s.amount), 0n).toString(),
        calls: sellerSettlements.reduce((a, s) => a + s.calls, 0),
        settlements: sellerSettlements.length,
      },
    };
  }

  async budgets(): Promise<BudgetRecord[]> {
    await Promise.all([delay(), payeesReady()]);
    return budgets.map((m) => ({ ...budgetView(m), payeeChecks: payeeService.payeeChecks(m.id) }));
  }

  #payeeBudget(id: string): MockBudget {
    const m = budgets.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!m) throw new ApiError(404, "NOT_FOUND", "No Budget with this id is registered on this node. GET /v1/budgets lists the ones that are.");
    return m;
  }

  async checkPayee(account: string, budgetId?: string) {
    await payeesReady();
    return payeeService.verdictFor(account, budgetId ? this.#payeeBudget(budgetId) : null);
  }

  async payeeApprovals(budgetId: string): Promise<PayeeApprovals> {
    await Promise.all([delay(), payeesReady()]);
    return payeeService.approvals(this.#payeeBudget(budgetId).id);
  }

  async decidePayee(budgetId: string, body: PayeeDecisionBody): Promise<PayeeApproval> {
    await Promise.all([delay(), payeesReady()]);
    return payeeService.decide(this.#payeeBudget(budgetId), body, DEMO_ACTOR);
  }

  async withdrawPayeeDecision(budgetId: string, payee: AccountId): Promise<PayeeApproval> {
    await Promise.all([delay(), payeesReady()]);
    return payeeService.withdraw(this.#payeeBudget(budgetId), payee);
  }

  async payeeReports(account: AccountId): Promise<PayeeReports> {
    await Promise.all([delay(), payeesReady()]);
    return payeeService.reports(account);
  }

  async reportPayee(body: PayeeReportBody): Promise<PayeeReportFiled> {
    await Promise.all([delay(), payeesReady()]);
    return payeeService.fileReport({ ...body }, DEMO_ACTOR);
  }

  async budget(id: string): Promise<BudgetDetail> {
    await Promise.all([delay(), payeesReady()]);
    const m = budgets.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!m) throw new ApiError(404, "NOT_FOUND", `No budget ${id} on this node.`);
    const own = calls.filter((c) => c.budgetId === m.id);
    const buckets = new Map<string, bigint>();
    for (const c of own) {
      const h = new Date(c.createdAt);
      h.setMinutes(0, 0, 0);
      const k = h.toISOString();
      buckets.set(k, (buckets.get(k) ?? 0n) + BigInt(c.amount));
    }
    return {
      ...budgetView(m),
      payeeChecks: payeeService.payeeChecks(m.id),
      recentCalls: own.slice(-40).reverse().map(stripCall),
      denials: denials.filter((d) => d.budgetId === m.id),
      spendSeries: [...buckets.entries()].sort().map(([day, amount]) => ({ day, amount: amount.toString() })),
    };
  }

  async createBudget(body: CreateBudgetBody): Promise<BudgetRecord> {
    await delay(600);
    const id = budgetIdOf(HUB, NETWORK, budgetTermsFromJson(body.budget as BudgetTermsJson));
    if (budgets.some((b) => b.id === id)) throw new ApiError(409, "BUDGET_EXISTS", "This Budget is already registered on this server.");
    // As the node: it registers only a Budget the hub already holds, which for a DAO owner means an approved proposal.
    if (!openedOnChain.has(id)) throw new ApiError(409, "BUDGET_NOT_ON_CHAIN", "open this Budget on the hub first, then register it here");
    const record: MockBudget = {
      id,
      label: body.label,
      status: "pending",
      budget: body.budget,
      owner: body.budget.owner,
      agent: body.budget.agentPk,
      settler: body.budget.settler,
      cap: body.budget.cap,
      expiresAt: new Date(Number(body.budget.validUntil)).toISOString(),
      policy: body.policy,
      payees: body.budget.payees,
      spend: { settled: "0", pending: "0", today: "0", remaining: body.budget.cap },
      openTxHash: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
      escrow: (pendingEscrow.get(id) ?? 0n).toString(),
      ownerCredit: "0",
      recentDenials: [],
    };
    budgets.unshift(record);
    setTimeout(() => {
      record.status = "open";
      record.openTxHash = txHashOf("open-tx");
      emit("budget.opened", budgetView(record) as unknown as Record<string, unknown>);
    }, 1800);
    // As the node: every Payee on the list is judged at registration, and the verdicts travel with the answer.
    await payeesReady();
    await payeeService.checkBudget(record);
    return { ...budgetView(record), payeeChecks: payeeService.payeeChecks(record.id) };
  }

  async revokeBudget(id: string): Promise<RevokeResult> {
    await delay(500);
    const m = budgets.find((x) => x.id === id);
    if (!m) throw new ApiError(404, "NOT_FOUND", `No budget ${id} on this node.`);
    m.status = "revoked";
    m.revokedAt = new Date().toISOString();
    emit("budget.revoked", budgetView(m) as unknown as Record<string, unknown>);
    return { budget: budgetView(m), onchain: { revoked: true, submitted: true, txHash: txHashOf("revoke-tx"), call: null } };
  }

  async providers(): Promise<Provider[]> {
    await delay();
    const dayAgo = Date.now() - 86_400_000;
    return providers.map((p) => {
      const own = calls.filter((c) => c.payee === p.payee);
      return {
        ...p,
        calls24h: own.filter((c) => new Date(c.createdAt).getTime() >= dayAgo).length,
        callsTotal: own.length,
        revenue: {
          settled: sumAmounts(own.filter((c) => c.status === "settled")).toString(),
          pending: sumAmounts(own.filter((c) => c.status === "accepted")).toString(),
        },
      };
    });
  }

  providerCatalog(): Promise<Provider[]> {
    return this.providers();
  }

  async provider(id: string): Promise<Provider> {
    const all = await this.providers();
    const p = all.find((x) => x.id === id);
    if (!p) throw new ApiError(404, "NOT_FOUND", `No provider ${id}.`);
    return p;
  }

  async createProvider(body: CreateProviderBody): Promise<{ id: string; apiKey: string }> {
    await delay(500);
    const id = `prv_${body.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
    providers.push({ ...body, id, calls24h: 0 });
    return { id, apiKey: `pmk_live_${toHex(crypto.getRandomValues(new Uint8Array(18)))}` };
  }

  async calls(q: CallsQuery = {}): Promise<Page<Call>> {
    await delay();
    let rows = [...calls].reverse();
    if (q.budgetId) rows = rows.filter((c) => c.budgetId === q.budgetId);
    if (q.payee) rows = rows.filter((c) => c.payee.toLowerCase() === q.payee!.toLowerCase());
    if (q.status) rows = rows.filter((c) => c.status === q.status);
    const start = q.cursor ? Number(q.cursor) : 0;
    const limit = q.limit ?? 50;
    const items = rows.slice(start, start + limit).map(stripCall);
    return { items, nextCursor: start + limit < rows.length ? String(start + limit) : null };
  }

  async denials(limit = 100): Promise<Denial[]> {
    await Promise.all([delay(), payeesReady()]);
    return denials.slice(0, limit);
  }

  async batches(): Promise<Batch[]> {
    await delay();
    return batches.map(batchSummary);
  }

  async batch(id: string): Promise<BatchDetail> {
    await delay();
    const b = batches.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!b) throw new ApiError(404, "NOT_FOUND", `No batch ${id}.`);
    return b;
  }

  async settle(): Promise<SettlementResult> {
    if (settling) throw new ApiError(409, "SETTLEMENT_RUNNING", "A settlement is already running.");
    const p = preview();
    if (p.calls === 0) return { skipped: "No accepted calls are waiting to be settled." };
    settling = true;
    const seq = batches.length + 1;
    emit("batch.started", { seq, calls: p.calls });
    await delay(900);
    emit("batch.submitted", { seq });
    await delay(1600);
    const b = settlePending(Date.now());
    settling = false;
    if (!b) return { skipped: "Nothing to settle." };
    emit("batch.confirmed", batchSummary(b) as unknown as Record<string, unknown>);
    return { batchIds: [b.id] };
  }

  async nettingPreview(): Promise<NettingPreview> {
    await delay();
    return preview();
  }

  async ledger(q: { account?: string; limit?: number } = {}): Promise<LedgerEntry[]> {
    await delay();
    let rows = [...ledger].reverse();
    if (q.account) rows = rows.filter((e) => e.account === q.account);
    return rows.slice(0, q.limit ?? 200);
  }

  async trialBalance(): Promise<TrialBalance> {
    await delay();
    const acc = new Map<string, { debit: bigint; credit: bigint }>();
    for (const e of ledger) {
      const a = acc.get(e.account) ?? { debit: 0n, credit: 0n };
      a.debit += BigInt(e.debit);
      a.credit += BigInt(e.credit);
      acc.set(e.account, a);
    }
    const accounts = [...acc.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([account, v]) => ({ account, debit: v.debit.toString(), credit: v.credit.toString(), balance: (v.debit - v.credit).toString() }));
    const totalDebit = [...acc.values()].reduce((s, v) => s + v.debit, 0n);
    const totalCredit = [...acc.values()].reduce((s, v) => s + v.credit, 0n);
    return { accounts, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString(), balance: (totalDebit - totalCredit).toString() };
  }

  async payouts(): Promise<Payouts> {
    await delay();
    return { accounts: payoutAccounts(), payouts: payoutRuns };
  }

  async runPayouts(): Promise<PayoutRun> {
    await delay(900);
    const due = payoutAccounts().filter((a) => a.status === "due");
    const waiting = payoutAccounts().filter((a) => a.status === "waiting_registration").map((a) => a.account);
    if (due.length === 0) return { skipped: "No account has credit due." };
    const tx = txHashOf("payout");
    const run: Payout = {
      seq: payoutRuns.length + 1,
      status: "confirmed",
      trigger: "manual",
      txHash: tx,
      explorerUrl: explorerTx(NETWORK, tx),
      error: null,
      createdAt: iso(Date.now() - 3_000),
      finishedAt: iso(Date.now()),
      items: due.map((a) => ({ account: a.account, creditBefore: a.credit, creditAfter: "0", paid: a.credit, outcome: "paid" as const })),
    };
    for (const a of due) paidOut.set(a.account, (paidOut.get(a.account) ?? 0n) + BigInt(a.credit));
    payoutRuns.unshift(run);
    return { payouts: [run], waitingRegistration: waiting };
  }

  async settlementExportCsv(range: { from?: string; to?: string; account?: string }): Promise<string> {
    await delay();
    return settlementCsv(range);
  }

  async receiptProof(callId: string): Promise<ReceiptProof> {
    await delay(400);
    const c = calls.find((x) => x.id.toLowerCase() === callId.toLowerCase());
    if (!c) throw new ApiError(404, "NOT_FOUND", `No call ${callId} on this node.`);
    const receipt: ReceiptProof["receipt"] = {
      callId: c.id,
      budgetId: c.budgetId,
      payee: c.payee,
      amount: c.amount,
      cumulative: c.cumulative,
      requestHash: c.requestHash,
      timestamp: Number(c.timestampSec),
      voucherSig: voucherSigOf(c.id),
      digest: sha256Text(`digest:${c.id}`),
      nodeSignature: voucherSigOf(`node:${c.id}`),
      node: agentKey("node-key"),
    };
    // Settled by its seller on the hub: in no batch, so there is no root, leaf or Merkle proof, only the settled position.
    const seller = sellerSettledCalls.get(c.id);
    if (seller) {
      const hubSettled = settledPos.get(`${c.budgetId}:${c.payee}`) ?? 0n;
      return {
        receipt,
        status: c.status,
        settledBy: "seller",
        sellerSettlement: { id: seller.id, previous: seller.previous, cumulative: seller.cumulative, detectedAt: seller.detectedAt, hubSettled: hubSettled.toString(), covered: hubSettled >= BigInt(c.cumulative) },
        batchId: null,
        batchStatus: null,
        receiptsRoot: null,
        proof: [],
        leaf: null,
        txHash: null,
        explorerUrl: null,
        onchainVerified: null,
      };
    }
    if (!c.batchId) return { receipt, status: c.status, batchId: null, batchStatus: null, receiptsRoot: null, proof: [], leaf: null, txHash: null, explorerUrl: null, onchainVerified: null };
    const b = batches.find((x) => x.id === c.batchId)!;
    const tree = trees.get(b.id)!;
    const proof = tree.proofOf(c.id);
    const leaf = receiptLeaf(HUB, NETWORK, b.id, toFields(c));
    return {
      receipt,
      status: c.status,
      batchId: b.id,
      batchStatus: b.status,
      receiptsRoot: b.receiptsRoot,
      proof,
      leaf,
      txHash: b.txHash,
      explorerUrl: b.explorerUrl,
      onchainVerified: verifyMerkleProof(tree.root, leaf, proof),
    };
  }

  eventsUrl() {
    return null;
  }

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    const offAgents = subscribeAgentEvents(listener);
    startTraffic();
    playDemoEvents();
    return () => {
      listeners.delete(listener);
      offAgents();
      if (listeners.size === 0 && ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    };
  }

  /** Mock-only: a party directory so screens can name wallets the way a live node's data implies. */
  static readonly parties = { HUB, TOKEN, OPERATOR, TREASURY_OWNER, TRADING_OWNER, TREASURY_AGENT, TRADING_AGENT, MARKET_DATA, RISK_SCAN, RESEARCH_WRITER, UNLISTED };
}

function stripCall(c: MockCall): Call {
  const { timestampSec: _t, ...rest } = c;
  void _t;
  return rest;
}
