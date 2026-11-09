/**
 * In-memory Clearing Node for NEXT_PUBLIC_MOCK=1.
 * Deterministic fixtures (3 providers, 2 agents plus Research Writer buying on its own mandate, ~530 calls,
 * 2 settled batches and denials) built with the real protocol helpers, so Merkle proofs and netting are genuine.
 */
import { getAddress, keccak256, toBytes, toHex, type Address, type Hex } from "viem";
import {
  DENIAL_RULES,
  explorerTx,
  networkFor,
  payeesRoot,
  policyHash,
  receiptLeaf,
  receiptProof,
  receiptsTree,
  verifyReceiptProof,
  type CallReceipt,
  type DenialRule,
  type Policy,
} from "@payminto/protocol";
import type { CallsQuery, ClearingApi, CreateMandateBody, CreateProviderBody, Page } from "../api";
import { ApiError } from "../api";
import { MockGatewayApi, MockOperatorApi } from "./gateway";
import { MockAgentsApi, subscribeAgentEvents } from "./agents";
import { aggregateObligations, netTransfers, sumAmounts } from "../netting";
import type {
  Batch,
  BatchDetail,
  Call,
  Claim,
  Denial,
  EventType,
  Health,
  HspStatus,
  Info,
  LedgerEntry,
  MandateDetail,
  MandateRecord,
  NettingPreview,
  NetTransfer,
  NodeEvent,
  Overview,
  Provider,
  ReceiptProof,
  RevokeResult,
  SettlementResult,
  TrialBalance,
} from "../schemas";

const CHAIN_ID = 133;
const EMPTY = process.env.NEXT_PUBLIC_MOCK === "empty";
/** The chain package owns the explorer URL (testnet-explorer.hsk.xyz does not resolve). */
const EXPLORER = networkFor(CHAIN_ID).explorer;
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
const hashOf = (label: string): Hex => keccak256(toBytes(`${label}:${hashCounter++}`));
const addr = (label: string): Address => getAddress(`0x${keccak256(toBytes(label)).slice(-40)}`);

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

const HUB = addr("clearing-hub");
const TOKEN = getAddress("0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6");
const OPERATOR = addr("node-operator");
const OWNER = addr("treasury-safe");
const TREASURY_AGENT = addr("treasury-agent");
const TRADING_AGENT = addr("trading-agent");
const MARKET_DATA = addr("market-data-payee");
const RISK_SCAN = addr("risk-scan-payee");
const RESEARCH_WRITER = addr("research-writer-wallet");
const UNLISTED = addr("prompt-injection-payee");

type MockMandate = MandateRecord & { recentDenials: Denial[] };

const providers: Provider[] = [
  {
    id: "prv_market_data",
    name: "Market Data",
    description: "Spot quotes for HSK and BTC with a deterministic fallback when the live source is down.",
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

function makeMandate(args: {
  key: string;
  label: string;
  agent: Address;
  totalCap: bigint;
  policy: Policy;
  payees: Address[];
  createdMs: number;
  validDays: number;
  status?: MandateRecord["status"];
}): MockMandate {
  const m = {
    owner: OWNER,
    agent: args.agent,
    token: TOKEN,
    totalCap: args.totalCap.toString(),
    validAfter: sec(args.createdMs).toString(),
    validUntil: sec(args.createdMs + args.validDays * 86_400_000).toString(),
    payeesRoot: payeesRoot(args.payees),
    policyHash: policyHash(args.policy),
    salt: keccak256(toBytes(`salt:${args.key}`)),
  };
  return {
    id: keccak256(toBytes(`mandate:${args.key}`)),
    label: args.label,
    status: args.status ?? "open",
    mandate: m,
    policy: args.policy,
    payees: args.payees,
    spend: { settled: "0", pending: "0", today: "0", remaining: args.totalCap.toString() },
    openTxHash: hashOf("open-tx"),
    revokedAt: args.status === "revoked" ? iso(args.createdMs + 3_600_000) : null,
    createdAt: iso(args.createdMs),
    agentBalance: (args.totalCap * 2n).toString(),
    // The trading agent approved less than its cap, so the wallet panel shows the approve action.
    agentAllowance: args.key === "trading" ? (500_000n).toString() : args.totalCap.toString(),
    recentDenials: [],
  };
}

const mandates: MockMandate[] = [
  makeMandate({
    key: "treasury",
    label: "Treasury Agent - Q4 market research",
    agent: TREASURY_AGENT,
    totalCap: 8n * USDC,
    policy: { perCallCap: (100_000n).toString(), dailyCap: (4n * USDC).toString(), maxCallsPerMinute: 120, purpose: "Research agent for the Q4 market report" },
    payees: [MARKET_DATA, RISK_SCAN, RESEARCH_WRITER],
    createdMs: now - 3 * 86_400_000,
    validDays: 30,
  }),
  makeMandate({
    key: "trading",
    label: "Trading Agent - live quotes",
    agent: TRADING_AGENT,
    totalCap: 2n * USDC,
    policy: { perCallCap: (20_000n).toString(), dailyCap: (1n * USDC).toString(), maxCallsPerMinute: 300, purpose: "Intraday quotes and counterparty checks" },
    payees: [MARKET_DATA, RISK_SCAN],
    createdMs: now - 2 * 86_400_000,
    validDays: 14,
  }),
  makeMandate({
    key: "writer",
    label: "Research Writer - sourcing",
    agent: RESEARCH_WRITER,
    totalCap: 3n * USDC,
    policy: { perCallCap: (20_000n).toString(), dailyCap: (1_500_000n).toString(), maxCallsPerMinute: 120, purpose: "Buys inputs for paid research briefs" },
    payees: [MARKET_DATA, RISK_SCAN],
    createdMs: now - 2 * 86_400_000,
    validDays: 30,
  }),
  makeMandate({
    key: "pilot",
    label: "Trading Agent - pilot",
    agent: TRADING_AGENT,
    totalCap: 5n * USDC,
    policy: { perCallCap: (20_000n).toString(), dailyCap: (1n * USDC).toString(), maxCallsPerMinute: 60, purpose: "First week pilot, replaced by live quotes" },
    payees: [MARKET_DATA],
    createdMs: now - 6 * 86_400_000,
    validDays: 7,
    status: "revoked",
  }),
];

if (EMPTY) mandates.length = 0;

// ---------------------------------------------------------------------------
// Calls, denials, batches
// ---------------------------------------------------------------------------

type MockCall = Call & { timestampSec: bigint };
const calls: MockCall[] = [];
const denials: Denial[] = [];
const batches: BatchDetail[] = [];
const ledger: LedgerEntry[] = [];
const positions = new Map<string, bigint>(); // `${mandateId}:${payee}` -> cumulative accepted
const settledPos = new Map<string, bigint>(); // `${mandateId}:${payee}` -> cumulative settled
let journalSeq = 0;
let ledgerSeq = 0;

const mixes: { mandate: MockMandate; weights: [Address, number][] }[] = [
  { mandate: mandates[0]!, weights: [[MARKET_DATA, 0.5], [RISK_SCAN, 0.33], [RESEARCH_WRITER, 0.17]] },
  { mandate: mandates[1]!, weights: [[MARKET_DATA, 0.8], [RISK_SCAN, 0.2]] },
  { mandate: mandates[2]!, weights: [[MARKET_DATA, 0.6], [RISK_SCAN, 0.4]] },
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

function acceptCall(mandate: MockMandate, payee: Address, atMs: number): MockCall {
  const key = `${mandate.id}:${payee}`;
  const amount = priceOf(payee);
  const cumulative = (positions.get(key) ?? 0n) + amount;
  positions.set(key, cumulative);
  const call: MockCall = {
    id: hashOf("call"),
    mandateId: mandate.id,
    agent: mandate.mandate.agent,
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
    { account: `agent:${call.agent}:payable`, credit: amount },
  ]);
  return call;
}

function deny(rule: DenialRule, atMs: number, extra: Partial<Denial> = {}): Denial {
  const d: Denial = {
    id: `dn_${denials.length + 1}`,
    rule,
    message: DENIAL_RULES[rule],
    createdAt: iso(atMs),
    ...extra,
  };
  denials.unshift(d);
  return d;
}

const toReceipt = (c: MockCall): CallReceipt => ({
  callId: c.id as Hex,
  mandateId: c.mandateId as Hex,
  payee: c.payee as Address,
  amount: BigInt(c.amount),
  cumulative: BigInt(c.cumulative),
  requestHash: c.requestHash as Hex,
  timestamp: c.timestampSec,
});

const trees = new Map<string, ReturnType<typeof receiptsTree>>();

function settlePending(atMs: number, hspPlan: (i: number) => HspStatus = () => "ACCEPT"): BatchDetail | null {
  const pending = calls.filter((c) => c.status === "accepted");
  if (pending.length === 0) return null;
  const seq = batches.length + 1;
  const tree = receiptsTree(pending.map(toReceipt));
  const receiptsRoot = tree.root as Hex;
  const batchId = keccak256(toBytes(`${CHAIN_ID}:${HUB}:${receiptsRoot}:${seq}`));

  // Latest voucher per (mandate, payee) and its delta over what is already settled.
  const latest = new Map<string, MockCall>();
  const counts = new Map<string, number>();
  for (const c of pending) {
    const k = `${c.mandateId}:${c.payee}`;
    latest.set(k, c);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const claimList: Claim[] = [...latest.entries()].map(([k, c]) => {
    const prior = settledPos.get(k) ?? 0n;
    settledPos.set(k, BigInt(c.cumulative));
    return {
      mandateId: c.mandateId,
      agent: c.agent,
      payee: c.payee,
      cumulative: c.cumulative,
      delta: (BigInt(c.cumulative) - prior).toString(),
      calls: counts.get(k) ?? 0,
    };
  });
  const obligations = claimList.map((c) => ({ from: c.agent, to: c.payee, amount: c.delta }));
  const net = netTransfers(obligations);
  const txHash = hashOf("settle-tx");
  const at = iso(atMs);
  const netTransfersOut: NetTransfer[] = net.map((t, i) => {
    const status = hspPlan(i);
    return {
      ...t,
      logIndex: i * 2 + 1,
      hsp: {
        paymentId: hashOf("hsp"),
        status,
        cosigned: status !== "UNSIGNED",
        reason:
          status === "UNSIGNED"
            ? "Settled on chain from agent-signed vouchers. The payer agent did not co-sign the HSP mandate within the 20 s window."
            : status === "REJECT"
              ? "Required capability proves:settlement-verified:v1 was not satisfied."
              : null,
        updatedAt: at,
      },
    };
  });
  const gross = sumAmounts(obligations);
  const netTotal = sumAmounts(net);
  const gasUsed = 95_000n + 41_000n * BigInt(claimList.length) + 29_000n * BigInt(net.length);
  const batch: BatchDetail = {
    id: batchId,
    seq,
    status: "confirmed",
    receiptsRoot,
    token: TOKEN,
    txHash,
    explorerUrl: explorerTx(CHAIN_ID, txHash),
    gross: gross.toString(),
    net: netTotal.toString(),
    calls: pending.length,
    claims: claimList.length,
    transfers: net.length,
    gasUsed: gasUsed.toString(),
    error: null,
    createdAt: iso(atMs - 14_000),
    confirmedAt: at,
    claimList,
    netTransfers: netTransfersOut,
  };
  batches.unshift(batch);
  trees.set(batchId, tree);
  for (const c of pending) {
    c.status = "settled";
    c.batchId = batchId;
  }
  journal(at, `Batch #${seq} vouchers settled`, batchId, claimList.flatMap((c) => [
    { account: `agent:${c.agent}:payable`, debit: BigInt(c.delta) },
    { account: `provider:${c.payee}:receivable`, credit: BigInt(c.delta) },
  ]));
  journal(at, `Batch #${seq} net transfers`, txHash, net.flatMap((t) => [
    { account: `${roleOf(t.to)}:${t.to}:wallet`, debit: BigInt(t.amount) },
    { account: `${roleOf(t.from)}:${t.from}:wallet`, credit: BigInt(t.amount) },
  ]));
  return batch;
}

function roleOf(address: string): "agent" | "provider" {
  return providers.some((p) => p.payee === address) ? "provider" : "agent";
}

function generateCalls(count: number, startMs: number, endMs: number) {
  const times = Array.from({ length: count }, () => startMs + rand() * (endMs - startMs)).sort((a, b) => a - b);
  for (const t of times) {
    const mix = pick<(typeof mixes)[number]>([[mixes[0]!, 0.3], [mixes[1]!, 0.36], [mixes[2]!, 0.34]]);
    acceptCall(mix.mandate, pick(mix.weights), t);
  }
}

// NEXT_PUBLIC_MOCK=empty starts from a fresh node, which shows the first-run guide.
if (!EMPTY) {
  // History: batch 1 about 5 hours ago, batch 2 about 2 hours ago, then calls waiting to be netted.
  generateCalls(214, now - 9 * 3_600_000, now - 5 * 3_600_000);
  deny("PAYEE_NOT_ALLOWED", now - 6.2 * 3_600_000, { mandateId: mandates[0]!.id, agent: TREASURY_AGENT, payee: UNLISTED, amount: "250000", message: `${DENIAL_RULES.PAYEE_NOT_ALLOWED}. A tool result asked the agent to pay ${UNLISTED.slice(0, 10)}…` });
  settlePending(now - 5 * 3_600_000);
  generateCalls(178, now - 5 * 3_600_000 + 60_000, now - 2 * 3_600_000);
  deny("PER_CALL_CAP", now - 3.1 * 3_600_000, { mandateId: mandates[1]!.id, agent: TRADING_AGENT, payee: RISK_SCAN, providerId: "prv_risk_scan", amount: "500000", message: `${DENIAL_RULES.PER_CALL_CAP}: 0.50 USDC asked, cap is 0.02 USDC` });
  deny("STALE_CUMULATIVE", now - 2.8 * 3_600_000, { mandateId: mandates[1]!.id, agent: TRADING_AGENT, payee: MARKET_DATA, providerId: "prv_market_data", amount: "2000" });
  settlePending(now - 2 * 3_600_000, (i) => (i === 1 ? "UNSIGNED" : i === 0 ? "SETTLED" : "ACCEPT"));
  generateCalls(138, now - 2 * 3_600_000 + 60_000, now - 90_000);
  deny("PAYEE_NOT_ALLOWED", now - 50 * 60_000, { mandateId: mandates[0]!.id, agent: TREASURY_AGENT, payee: UNLISTED, amount: "1000000", message: `${DENIAL_RULES.PAYEE_NOT_ALLOWED}. A scraped page asked the agent to pay ${UNLISTED.slice(0, 10)}…` });
  deny("PER_CALL_CAP", now - 34 * 60_000, { mandateId: mandates[2]!.id, agent: RESEARCH_WRITER, payee: RISK_SCAN, providerId: "prv_risk_scan", amount: "40000", message: `${DENIAL_RULES.PER_CALL_CAP}: 0.04 USDC asked, cap is 0.02 USDC` });
  deny("RATE_LIMIT", now - 21 * 60_000, { mandateId: mandates[1]!.id, agent: TRADING_AGENT, payee: MARKET_DATA, providerId: "prv_market_data", amount: "2000" });
  deny("MANDATE_REVOKED", now - 12 * 60_000, { mandateId: mandates[3]!.id, agent: TRADING_AGENT, payee: MARKET_DATA, providerId: "prv_market_data", amount: "2000" });
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

function spendOf(m: MockMandate) {
  let settled = 0n;
  let pending = 0n;
  let today = 0n;
  const dayAgo = Date.now() - 86_400_000;
  for (const c of calls) {
    if (c.mandateId !== m.id) continue;
    const a = BigInt(c.amount);
    if (c.status === "settled") settled += a;
    else pending += a;
    if (new Date(c.createdAt).getTime() >= dayAgo) today += a;
  }
  const remaining = BigInt(m.mandate.totalCap) - settled - pending;
  return { settled: settled.toString(), pending: pending.toString(), today: today.toString(), remaining: (remaining < 0n ? 0n : remaining).toString() };
}

function mandateView(m: MockMandate): MandateRecord {
  const { recentDenials: _d, ...rest } = m;
  void _d;
  return { ...rest, spend: spendOf(m) };
}

function batchSummary(b: BatchDetail): Batch {
  const { claimList: _c, netTransfers: _n, ...rest } = b;
  void _c;
  void _n;
  return rest;
}

function preview(): NettingPreview {
  const pending = calls.filter((c) => c.status === "accepted");
  const gross = aggregateObligations(pending.map((c) => ({ from: c.agent, to: c.payee, amount: c.amount, calls: 1 })));
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
    const d = deny("PAYEE_NOT_ALLOWED", Date.now(), { mandateId: mandates[0]!.id, agent: TREASURY_AGENT, payee: UNLISTED, amount: "250000" });
    emit("call.denied", d as unknown as Record<string, unknown>);
    return;
  }
  const mix = pick<(typeof mixes)[number]>([[mixes[0]!, 0.3], [mixes[1]!, 0.36], [mixes[2]!, 0.34]]);
  const c = acceptCall(mix.mandate, pick(mix.weights), Date.now());
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

export class MockClearingApi implements ClearingApi {
  readonly mock = true;
  readonly nodeUrl = "mock://clearing-node";
  readonly gateway = new MockGatewayApi();
  readonly operator = new MockOperatorApi();
  readonly agents = new MockAgentsApi();
  readonly role = "operator" as const;

  async health(): Promise<Health> {
    await delay(80);
    return { ok: true, chainId: CHAIN_ID, hub: HUB, token: TOKEN, operator: OPERATOR, blockNumber: 18_204_331 + Math.floor((Date.now() - now) / 2000), hspMode: "local" };
  }

  async info(): Promise<Info> {
    await delay();
    return {
      network: { chainId: CHAIN_ID, name: "HashKey Chain Testnet" },
      chainId: CHAIN_ID,
      hub: HUB,
      token: { address: TOKEN, symbol: "USDC", decimals: 6 },
      explorer: EXPLORER,
      operator: OPERATOR,
      version: "0.1.0-mock",
      hspMode: "local",
      operatorGasBalance: (2_418_000_000_000_000_000n).toString(),
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
    const gasUsed = batches.reduce((a, b) => a + BigInt(b.gasUsed ?? "0"), 0n);
    const naive = BigInt(settled.length) * 52_000n;
    return {
      volume: { settled: sumAmounts(settled).toString(), pending: sumAmounts(pending).toString() },
      calls: { last24h: calls.filter((c) => new Date(c.createdAt).getTime() >= dayAgo).length, all: calls.length },
      denials24h: denials.filter((d) => new Date(d.createdAt).getTime() >= dayAgo).length,
      activeMandates: mandates.filter((m) => m.status === "open").length,
      providers: providers.length,
      batches: batches.length,
      gasSaved: { gas: (naive > gasUsed ? naive - gasUsed : 0n).toString(), native: ((naive - gasUsed) * 1_000_000_000n).toString() },
      compressionRatio: transfers ? settled.length / transfers : 0,
      lastBatch: batches[0] ? batchSummary(batches[0]) : null,
    };
  }

  async mandates(): Promise<MandateRecord[]> {
    await delay();
    return mandates.map(mandateView);
  }

  async mandate(id: string): Promise<MandateDetail> {
    await delay();
    const m = mandates.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!m) throw new ApiError(404, "NOT_FOUND", `No mandate ${id} on this node.`);
    const own = calls.filter((c) => c.mandateId === m.id);
    const buckets = new Map<string, bigint>();
    for (const c of own) {
      const h = new Date(c.createdAt);
      h.setMinutes(0, 0, 0);
      const k = h.toISOString();
      buckets.set(k, (buckets.get(k) ?? 0n) + BigInt(c.amount));
    }
    return {
      ...mandateView(m),
      recentCalls: own.slice(-40).reverse().map(stripCall),
      denials: denials.filter((d) => d.mandateId === m.id),
      spendSeries: [...buckets.entries()].sort().map(([day, amount]) => ({ day, amount: amount.toString() })),
    };
  }

  async createMandate(body: CreateMandateBody): Promise<MandateRecord> {
    await delay(600);
    const id = keccak256(toBytes(JSON.stringify(body.mandate)));
    const record: MockMandate = {
      id,
      label: body.label,
      status: "pending",
      mandate: body.mandate,
      policy: body.policy,
      payees: body.payees,
      spend: { settled: "0", pending: "0", today: "0", remaining: body.mandate.totalCap },
      openTxHash: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
      agentBalance: "0",
      agentAllowance: "0",
      recentDenials: [],
    };
    mandates.unshift(record);
    setTimeout(() => {
      record.status = "open";
      record.openTxHash = hashOf("open-tx");
      emit("mandate.opened", mandateView(record) as unknown as Record<string, unknown>);
    }, 1800);
    return mandateView(record);
  }

  async revokeMandate(id: string): Promise<RevokeResult> {
    await delay(500);
    const m = mandates.find((x) => x.id === id);
    if (!m) throw new ApiError(404, "NOT_FOUND", `No mandate ${id} on this node.`);
    m.status = "revoked";
    m.revokedAt = new Date().toISOString();
    emit("mandate.revoked", mandateView(m) as unknown as Record<string, unknown>);
    return { mandate: mandateView(m), onchain: { revoked: true, submitted: true, txHash: hashOf("revoke-tx"), call: null } };
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
    providers.push({ ...body, id, payee: getAddress(body.payee), calls24h: 0 });
    return { id, apiKey: `pmk_live_${toHex(crypto.getRandomValues(new Uint8Array(18))).slice(2)}` };
  }

  async calls(q: CallsQuery = {}): Promise<Page<Call>> {
    await delay();
    let rows = [...calls].reverse();
    if (q.mandateId) rows = rows.filter((c) => c.mandateId === q.mandateId);
    if (q.payee) rows = rows.filter((c) => c.payee.toLowerCase() === q.payee!.toLowerCase());
    if (q.status) rows = rows.filter((c) => c.status === q.status);
    const start = q.cursor ? Number(q.cursor) : 0;
    const limit = q.limit ?? 50;
    const items = rows.slice(start, start + limit).map(stripCall);
    return { items, nextCursor: start + limit < rows.length ? String(start + limit) : null };
  }

  async denials(limit = 100): Promise<Denial[]> {
    await delay();
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
    const b = settlePending(Date.now(), (i) => (i === 0 ? "SETTLED" : "ACCEPT"));
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

  async receiptProof(callId: string): Promise<ReceiptProof> {
    await delay(400);
    const c = calls.find((x) => x.id.toLowerCase() === callId.toLowerCase());
    if (!c) throw new ApiError(404, "NOT_FOUND", `No call ${callId} on this node.`);
    const r = toReceipt(c);
    const leaf = receiptLeaf(r);
    const receipt = {
      callId: c.id,
      mandateId: c.mandateId,
      payee: c.payee,
      amount: c.amount,
      cumulative: c.cumulative,
      requestHash: c.requestHash,
      timestamp: Number(c.timestampSec),
      leaf,
      nodeSignature: keccak256(toBytes(`sig:${c.id}`)) + keccak256(toBytes(`sig2:${c.id}`)).slice(2, 4),
      node: OPERATOR,
    } as ReceiptProof["receipt"];
    if (!c.batchId) return { receipt, batchId: null, receiptsRoot: null, proof: [], leaf, txHash: null, explorerUrl: null, onchainVerified: null };
    const b = batches.find((x) => x.id === c.batchId)!;
    const tree = trees.get(b.id)!;
    const proof = receiptProof(tree, r);
    return {
      receipt,
      batchId: b.id,
      receiptsRoot: b.receiptsRoot,
      proof,
      leaf,
      txHash: b.txHash,
      explorerUrl: b.explorerUrl,
      onchainVerified: verifyReceiptProof(b.receiptsRoot as Hex, r, proof),
    };
  }

  eventsUrl() {
    return null;
  }

  async mockApprove(mandateId: string, amount: string): Promise<void> {
    await delay(900);
    const m = mandates.find((x) => x.id === mandateId);
    if (m) m.agentAllowance = amount;
  }

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    const offAgents = subscribeAgentEvents(listener);
    startTraffic();
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
  static readonly parties = { HUB, TOKEN, OPERATOR, OWNER, TREASURY_AGENT, TRADING_AGENT, MARKET_DATA, RISK_SCAN, RESEARCH_WRITER, UNLISTED };
}

function stripCall(c: MockCall): Call {
  const { timestampSec: _t, ...rest } = c;
  void _t;
  return rest;
}
