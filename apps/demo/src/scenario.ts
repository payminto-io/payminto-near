import { erc20Abi, keccak256, parseEventLogs, toBytes, getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { clearingHubAbi, DENIAL_RULES, explorerTx, hashkeyNetworkFacts, type DenialRule } from "@payminto/protocol";
import type { AgentClient } from "@payminto/sdk";
import { dashboardPort, type Stack } from "./stack.ts";

export type Agent = "treasury" | "trading" | "writer";
export type CallKind = "quote" | "scan" | "brief" | "feed";

export type Progress = { done: number; total: number; ok: number; failed: number };

export type AttackResult = {
  name: string;
  agent: string;
  via: "sdk" | "mcp";
  target: string;
  /** Layer 1: the rule the agent's own SDK refused with before signing (null if it signed). */
  agentRule: string | null;
  /** Layer 2: the rule the clearing node denied the compromised agent's signed voucher with (recorded, on the dashboard). */
  nodeRule: string | null;
  /**
   * Set when the compromised client refused on its own and never sent a voucher (for example POSITION_UNVERIFIED when it
   * does not share the agent's receipt store), so layer 2 was not exercised. Never to be reported as "accepted".
   */
  compromisedLocalRule: string | null;
  ruleText: string | null;
  message: string;
  /** The LLM-facing tool error text, for the MCP path. */
  toolText?: string;
};

export type TrafficResult = {
  total: number;
  ok: number;
  failed: Array<{ kind: CallKind; agent: Agent; status: number | string }>;
  byKind: Record<CallKind, number>;
  byAgent: Record<"treasury" | "trading", number>;
  attacks: AttackResult[];
  sampleTradingCallId: Hex | null;
  ms: number;
};

type Job = { agent: "treasury" | "trading"; kind: CallKind; run: () => Promise<{ ok: boolean; status: number | string; callId?: Hex }> };

/** Deterministic pseudo-random sequence so every run (and the test) makes the same mix. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function scanTarget(i: number): Address {
  return getAddress(`0x${keccak256(toBytes(`counterparty-${i}`)).slice(26)}`);
}

const SYMBOLS = ["HSK", "BTC", "ETH"] as const;

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const toolText = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

function parseToolPayload(text: string): unknown {
  const i = text.indexOf("\n\n");
  try {
    return JSON.parse(i >= 0 ? text.slice(i + 2) : text);
  } catch {
    return null;
  }
}

/** Trading Agent tool call through the in-memory MCP client. */
async function mcpCall(stack: Stack, args: Record<string, unknown>): Promise<ToolResult> {
  return (await stack.trading.mcp.callTool({ name: "call_paid_service", arguments: args })) as ToolResult;
}

const ruleOf = (r: string | null) => (r && r in DENIAL_RULES ? DENIAL_RULES[r as DenialRule] : null);

async function nodeDenial(client: AgentClient, url: string, init?: RequestInit): Promise<{ rule: string | null; local: string | null; message: string }> {
  const res = await client.fetch(url, init);
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: { enforcedBy?: string } } } | null;
  if (res.status === 402 && body?.error?.details?.enforcedBy === "agent") {
    return { rule: null, local: body.error.code ?? "UNKNOWN", message: body.error.message ?? "" };
  }
  if (res.status !== 402) return { rule: null, local: null, message: `HTTP ${res.status}` };
  return { rule: body?.error?.code ?? null, local: null, message: body?.error?.message ?? "" };
}

/**
 * The prompt-injection step: the Trading Agent reads a paid feed through MCP, a post tells it to pay an unlisted wallet,
 * and its naive planner tries. Layer 1: its own wallet refuses before signing. Layer 2: a compromised runtime that skips
 * that guard signs anyway, and the clearing node denies and records it.
 */
export async function injectionAttack(stack: Stack): Promise<AttackResult> {
  const feed = await mcpCall(stack, { serviceId: stack.providerIds.market, url: `${stack.services.market}/v1/feed` });
  if (feed.isError) throw new Error(`feed call failed: ${toolText(feed)}`);
  const payload = parseToolPayload(toolText(feed)) as { response?: { posts?: Array<{ text: string }> } } | null;
  const post = payload?.response?.posts?.find((p) => /ignore your previous instructions/i.test(p.text));
  const url = post ? /(https?:\/\/\S+?)\s/.exec(post.text)?.[1] : undefined;
  if (!url) throw new Error("injection post not found in the feed");
  const r = await mcpCall(stack, { url });
  const text = toolText(r);
  const agentRule = r.isError ? (/mandate rule ([A-Z_]+)/.exec(text)?.[1] ?? null) : null;
  const node = await nodeDenial(stack.compromised.trading, url);
  return {
    name: "prompt injection: pay an unlisted wallet",
    agent: "Trading Agent",
    via: "mcp",
    target: `${url} (payee ${stack.addresses.rogue})`,
    agentRule,
    nodeRule: node.rule,
    compromisedLocalRule: node.local,
    ruleText: ruleOf(node.rule ?? agentRule),
    message: node.message,
    toolText: text.split("\n")[0],
  };
}

/** The over-cap step: the Treasury Agent asks for a 0.25 USDC deep dive against a 0.05 USDC per-call cap. */
export async function overCapAttack(stack: Stack): Promise<AttackResult> {
  const url = `${stack.services.writer}/v1/deep-dive`;
  const init = () => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "everything" }) });
  const res = await stack.treasury.fetch(url, init());
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  const agentRule = res.status === 402 ? (body?.error?.code ?? null) : null;
  const node = await nodeDenial(stack.compromised.treasury, url, init());
  return {
    name: "over the per-call cap",
    agent: "Treasury Agent",
    via: "sdk",
    target: `Research Writer Deep Dive (${stack.cfg.prices.deep} atomic, cap ${stack.policies.treasury.perCallCap})`,
    agentRule,
    nodeRule: node.rule,
    compromisedLocalRule: node.local,
    ruleText: ruleOf(node.rule ?? agentRule),
    message: node.message,
  };
}

function buildJobs(stack: Stack): Job[] {
  const p = stack.cfg.plan;
  const jobs: Job[] = [];
  const t = stack.treasury;
  let n = 0;
  const viaSdk = async (url: string, init?: RequestInit) => {
    const r = await t.fetch(url, init);
    await r.arrayBuffer();
    return { ok: r.status === 200, status: r.status };
  };
  const viaMcp = async (args: Record<string, unknown>) => {
    const r = await mcpCall(stack, args);
    const payload = parseToolPayload(toolText(r)) as { payment?: { callId?: Hex } } | null;
    return { ok: !r.isError && !!payload?.payment?.callId, status: r.isError ? toolText(r).split("\n")[0]! : 200, callId: payload?.payment?.callId };
  };
  for (let i = 0; i < p.treasuryMarket; i++) {
    const sym = SYMBOLS[i % 3]!;
    jobs.push({ agent: "treasury", kind: "quote", run: () => viaSdk(`${stack.services.market}/v1/quote?symbol=${sym}&n=${n++}`) });
  }
  for (let i = 0; i < p.treasuryRisk; i++) {
    jobs.push({ agent: "treasury", kind: "scan", run: () => viaSdk(`${stack.services.risk}/v1/scan?address=${scanTarget(i)}`) });
  }
  for (let i = 0; i < p.briefs; i++) {
    const body = JSON.stringify({ topic: `HSK treasury brief #${i + 1}`, symbols: ["HSK", "BTC"], address: scanTarget(1_000 + i) });
    jobs.push({ agent: "treasury", kind: "brief", run: () => viaSdk(`${stack.services.writer}/v1/brief`, { method: "POST", headers: { "content-type": "application/json" }, body }) });
  }
  // One of the Trading Agent's market calls is the feed read that carries the injection (run as an attack step).
  for (let i = 0; i < p.tradingMarket - 1; i++) {
    const sym = SYMBOLS[(i + 1) % 3]!;
    jobs.push({ agent: "trading", kind: "quote", run: () => viaMcp({ serviceId: stack.providerIds.market, query: { symbol: sym, n: n++ } }) });
  }
  for (let i = 0; i < p.tradingRisk; i++) {
    jobs.push({ agent: "trading", kind: "scan", run: () => viaMcp({ serviceId: stack.providerIds.risk, query: { address: scanTarget(5_000 + i) } }) });
  }
  // Interleave agents and services like real traffic, deterministically.
  const r = rng(177);
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!];
  }
  return jobs;
}

export type TrafficOptions = {
  /** Calls per second across all agents; 0 = as fast as the concurrency allows. */
  pacePerSec?: number;
  onProgress?: (p: Progress) => void;
  onAttack?: (a: AttackResult) => void;
  /** Called right before an attack fires (stage mode narrates it). */
  beforeAttack?: (name: "injection" | "overcap") => Promise<void> | void;
};

/** Runs the paid traffic with realistic concurrency, firing the two scripted attacks mid-run. */
export async function runTraffic(stack: Stack, o: TrafficOptions = {}): Promise<TrafficResult> {
  const jobs = buildJobs(stack);
  const started = Date.now();
  const total = jobs.length + 1; // + the feed read inside the injection step
  const res: TrafficResult = {
    total,
    ok: 0,
    failed: [],
    byKind: { quote: 0, scan: 0, brief: 0, feed: 0 },
    byAgent: { treasury: 0, trading: 0 },
    attacks: [],
    sampleTradingCallId: null,
    ms: 0,
  };
  let done = 0;
  const report = () => o.onProgress?.({ done, total, ok: res.ok, failed: res.failed.length });
  const injectAt = Math.floor(jobs.length * 0.4);
  const overcapAt = Math.floor(jobs.length * 0.6);
  let next = 0;
  let paceChain = Promise.resolve();
  const interval = o.pacePerSec && o.pacePerSec > 0 ? 1000 / o.pacePerSec : 0;
  const pace = () => {
    if (!interval) return Promise.resolve();
    const slot = paceChain.then(() => new Promise<void>((r) => setTimeout(r, interval)));
    paceChain = slot;
    return slot;
  };
  const attacks: Array<Promise<void>> = [];
  const fire = (name: "injection" | "overcap") =>
    attacks.push(
      (async () => {
        await o.beforeAttack?.(name);
        const a = name === "injection" ? await injectionAttack(stack) : await overCapAttack(stack);
        if (name === "injection") {
          done++;
          res.ok++;
          res.byKind.feed++;
          res.byAgent.trading++;
        }
        res.attacks.push(a);
        o.onAttack?.(a);
        report();
      })(),
    );

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      if (i === injectAt) fire("injection");
      if (i === overcapAt) fire("overcap");
      const job = jobs[i]!;
      await pace();
      let out: { ok: boolean; status: number | string; callId?: Hex };
      try {
        out = await job.run();
      } catch (err) {
        out = { ok: false, status: err instanceof Error ? err.message : String(err) };
      }
      done++;
      if (out.ok) {
        res.ok++;
        res.byKind[job.kind]++;
        res.byAgent[job.agent]++;
        if (job.agent === "trading" && out.callId && !res.sampleTradingCallId) res.sampleTradingCallId = out.callId;
      } else res.failed.push({ kind: job.kind, agent: job.agent, status: out.status });
      if (done % 5 === 0 || done === total) report();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, stack.cfg.concurrency) }, worker));
  await Promise.all(attacks);
  res.ms = Date.now() - started;
  report();
  return res;
}

// ---------------------------------------------------------------------------------------------- settle + summary

const batchSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    claims: z.number(),
    calls: z.number(),
    transfers: z.number(),
    gross: z.string(),
    net: z.string(),
    reconciled: z.boolean().nullable(),
    txHash: z.string().nullable(),
    explorerUrl: z.string().nullable(),
    gasUsed: z.string().nullable(),
    error: z.string().nullable(),
  })
  .loose();
const batchDetailSchema = batchSchema.extend({
  netTransfers: z.array(
    z
      .object({
        index: z.number(),
        from: z.string(),
        to: z.string(),
        amount: z.string(),
        hsp: z.object({ status: z.string(), cosigned: z.boolean(), reason: z.string().nullable() }).loose().nullable(),
      })
      .loose(),
  ),
});
const settleSchema = z.object({
  skipped: z.string().optional(),
  batchIds: z.array(z.string()).optional(),
  dropped: z.array(z.object({ mandateId: z.string(), payee: z.string(), reason: z.string() }).loose()).optional(),
});
const denialSchema = z.array(z.object({ id: z.string(), rule: z.string(), message: z.string(), mandateId: z.string(), payee: z.string(), amount: z.string() }).loose());
const tbSchema = z.object({ balanced: z.boolean(), balance: z.string(), totalDebit: z.string(), journals: z.number() }).loose();
const callsPageSchema = z.object({ items: z.array(z.object({ id: z.string(), seq: z.number(), status: z.string(), agent: z.string(), payee: z.string(), amount: z.string() }).loose()), nextCursor: z.string().nullable().optional() });
const proofSchema = z.object({ batchId: z.string().nullable(), leaf: z.string(), proof: z.array(z.string()), receiptsRoot: z.string().nullable(), onchainVerified: z.boolean().nullable(), txHash: z.string().nullable() }).loose();

export type SettleOutcome = { batchIds: Hex[]; dropped: Array<{ mandateId: string; payee: string; reason: string }>; ms: number; skipped?: string };

export async function settle(stack: Stack, o: { say?: (line: string) => void } = {}): Promise<SettleOutcome> {
  const t = Date.now();
  const r = await stack.admin.post("/v1/settlements", settleSchema, {});
  if (r.skipped !== undefined) return { batchIds: [], dropped: [], ms: Date.now() - t, skipped: r.skipped };
  const batchIds = (r.batchIds ?? []) as Hex[];
  // A public chain confirms at the node's CONFIRM_TAG (safe by default), well behind the latest head: proofs and
  // HSP statuses are read only once every batch is confirmed and reconciled.
  if (stack.cfg.live) await waitForConfirmed(stack, batchIds, o.say ?? (() => {}));
  return { batchIds, dropped: r.dropped ?? [], ms: Date.now() - t };
}

/** How long a batch can take to reach the node's confirm tag on this chain, with margin. */
export function confirmTimeoutMs(chainId: number, tag: "latest" | "safe" | "finalized" | null): number {
  if (tag === "latest") return 180_000;
  const facts = hashkeyNetworkFacts[chainId as keyof typeof hashkeyNetworkFacts];
  // Ethereum's safe head trails by one to two epochs (32 slots of 12 s each); finalized by two to three.
  const lagSec = facts ? (tag === "finalized" ? facts.finalizedLagBlocks : facts.safeLagBlocks) * facts.blockTimeSeconds : tag === "finalized" ? 3 * 384 : 2 * 384;
  return lagSec * 1_500 + 180_000;
}

/**
 * The confirm wait for this run: the chain's measured lag behind the latest head right now (from block timestamps),
 * with margin, and never less than confirmTimeoutMs. The safe head on 133 trailed 300 blocks when measured and 712
 * blocks on 2026-11-02, so a constant alone is not enough.
 */
export async function liveConfirmTimeoutMs(stack: Pick<Stack, "cfg" | "rpc">): Promise<number> {
  const tag = stack.cfg.confirmTag;
  const floor = confirmTimeoutMs(stack.cfg.chainId, tag);
  if (tag === "latest") return floor;
  try {
    const [latest, head] = await Promise.all([stack.rpc.pub.getBlock({ blockTag: "latest" }), stack.rpc.pub.getBlock({ blockTag: tag ?? "safe" })]);
    const lagSec = Number(latest.timestamp - head.timestamp);
    return Math.max(floor, lagSec * 1_500 + 180_000);
  } catch {
    return floor;
  }
}

async function waitForConfirmed(stack: Stack, batchIds: Hex[], say: (line: string) => void): Promise<void> {
  const tag = stack.cfg.confirmTag ?? "safe";
  const timeout = await liveConfirmTimeoutMs(stack);
  const end = Date.now() + timeout;
  say(`waiting for ${batchIds.length} batch${batchIds.length === 1 ? "" : "es"} to confirm at the ${tag} head and reconcile (up to ${Math.round(timeout / 60_000)} min)`);
  let last = "";
  for (;;) {
    const rows = await Promise.all(batchIds.map((id) => stack.admin.get(`/v1/batches/${id}`, batchSchema)));
    const failed = rows.find((b) => b.status === "failed");
    if (failed) throw new Error(`batch ${failed.id} failed: ${failed.error ?? "no reason given"}`);
    if (rows.every((b) => b.status === "confirmed" && b.reconciled !== null)) {
      say(`confirmed: ${rows.map((b) => `${b.id.slice(0, 10)} ${b.reconciled ? "reconciled" : "NOT reconciled"}`).join(", ")}`);
      // Proofs are checked against the hub's batch record; a load-balanced RPC can still answer from an older block.
      for (const id of batchIds) {
        for (let streak = 0, i = 0; streak < 3; i++) {
          if (i >= 30) throw new Error(`batch ${id} is confirmed but the hub's record is not visible on the RPC after 60 s`);
          const rec = (await stack.rpc.pub.readContract({ address: stack.hub, abi: clearingHubAbi, functionName: "batches", args: [id] })) as readonly unknown[];
          streak = BigInt(rec[3] as bigint | number) !== 0n ? streak + 1 : 0;
          await new Promise((res) => setTimeout(res, 2_000));
        }
      }
      // A FAILED HSP verdict is retryable (an RPC that could not show the batch yet); the node retries it within
      // seconds, so the checks read the final verdicts.
      for (let i = 0, said = false; ; i++) {
        const details = await Promise.all(batchIds.map((id) => stack.admin.get(`/v1/batches/${id}`, batchDetailSchema)));
        const retrying = details.flatMap((d) => d.netTransfers).filter((t) => t.hsp?.status === "FAILED").length;
        if (retrying === 0) break;
        if (i >= 24) {
          say(`${retrying} HSP payment${retrying === 1 ? " is" : "s are"} still FAILED after 2 min of node retries`);
          break;
        }
        if (!said) say(`${retrying} HSP payment${retrying === 1 ? "" : "s"} FAILED on a lagging RPC; waiting for the node's retry`);
        said = true;
        await new Promise((res) => setTimeout(res, 5_000));
      }
      return;
    }
    const now = rows.map((b) => b.status).join(", ");
    if (now !== last) say(`batch status: ${now}`);
    last = now;
    if (Date.now() > end) throw new Error(`batches not confirmed after ${Math.round(timeout / 1000)} s (status ${now}); a lagging chain, or set DEMO_CONFIRM_TAG=latest for a testnet rehearsal`);
    await new Promise((res) => setTimeout(res, 5_000));
  }
}

export type Summary = {
  network: { chainId: number; live: boolean; hub: Address; token: Address; rpc: string; confirmTag: "latest" | "safe" | "finalized" | null };
  calls: number;
  failedCalls: number;
  callsPerSec: number;
  gross: bigint;
  net: bigint;
  batches: Array<z.infer<typeof batchDetailSchema>>;
  transfersOnchain: number;
  compression: number;
  gas: { used: bigint; naivePerCall: bigint; naive: bigint; saved: bigint; savedPct: number; nodeEstimateNaive: bigint };
  denials: Array<{ rule: string; ruleText: string; message: string; count: number }>;
  attacks: AttackResult[];
  hsp: Array<{ batch: string; index: number; from: string; to: string; amount: string; status: string; cosigned: boolean }>;
  trialBalance: { balanced: boolean; balance: string; journals: number };
  hubBalance: bigint;
  /** The permit-onboarded agent and how many transactions it sent during the whole run (must be 0). */
  gasless: { label: string; address: Address; transactions: number };
  proof: { seq: number; callId: string; batchId: string; proofLength: number; verifiedOnchain: boolean; nodeSaid: boolean | null } | null;
  mcpProof: { callId: string; verified: boolean | null } | null;
  dropped: SettleOutcome["dropped"];
  settleMs: number;
  runMs: number;
  dashboard: { url: string; nodeUrl: string; rpcUrl: string };
  names: Record<string, string>;
  marketDataSource: string;
};

async function allCalls(stack: Stack) {
  const out: Array<z.infer<typeof callsPageSchema>["items"][number]> = [];
  let cursor: string | null | undefined = undefined;
  for (let i = 0; i < 100; i++) {
    const page: z.infer<typeof callsPageSchema> = await stack.admin.get(`/v1/calls?limit=200${cursor ? `&cursor=${cursor}` : ""}`, callsPageSchema);
    out.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  return out;
}

/** Proves call number `seq` (1-based, as the dashboard shows) on chain, independently of the node. */
export async function proveCall(stack: Stack, seq?: number) {
  const calls = (await allCalls(stack)).filter((c) => c.status === "settled");
  if (calls.length === 0) return null;
  const pick = seq !== undefined ? calls.find((c) => c.seq === seq) : calls[Math.floor(Math.random() * calls.length)];
  if (!pick) return null;
  const p = await stack.admin.get(`/v1/receipts/${pick.id}/proof`, proofSchema);
  if (!p.batchId) return null;
  const verified = (await stack.rpc.pub.readContract({
    address: stack.hub,
    abi: clearingHubAbi,
    functionName: "verifyReceipt",
    args: [p.batchId as Hex, p.leaf as Hex, p.proof as Hex[]],
  })) as boolean;
  return { seq: pick.seq, callId: pick.id, batchId: p.batchId, proofLength: p.proof.length, verifiedOnchain: verified, nodeSaid: p.onchainVerified, txHash: p.txHash };
}

export async function collectSummary(stack: Stack, traffic: TrafficResult, s: SettleOutcome, runStarted: number): Promise<Summary> {
  const batches = await Promise.all(s.batchIds.map((id) => stack.admin.get(`/v1/batches/${id}`, batchDetailSchema)));
  let used = 0n;
  let transfersOnchain = 0;
  for (const b of batches) {
    if (!b.txHash) continue;
    const rc = await stack.rpc.pub.getTransactionReceipt({ hash: b.txHash as Hex });
    used += rc.gasUsed;
    transfersOnchain += parseEventLogs({ abi: clearingHubAbi, eventName: "NetTransfer", logs: rc.logs }).length;
  }
  // Naive baseline, measured: what one ERC-20 transfer per call costs on this chain right now.
  const naivePerCall = await stack.rpc.pub.estimateContractGas({
    address: stack.token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [stack.addresses.market, stack.cfg.prices.market],
    account: stack.addresses.treasury,
  });
  const calls = batches.reduce((n, b) => n + b.calls, 0);
  const naive = naivePerCall * BigInt(calls);
  const gross = batches.reduce((n, b) => n + BigInt(b.gross), 0n);
  const net = batches.reduce((n, b) => n + BigInt(b.net), 0n);
  const denialRows = await stack.admin.get("/v1/denials?limit=200", denialSchema);
  const grouped = new Map<string, { rule: string; ruleText: string; message: string; count: number }>();
  for (const d of denialRows) {
    const g = grouped.get(d.rule) ?? { rule: d.rule, ruleText: d.rule in DENIAL_RULES ? DENIAL_RULES[d.rule as DenialRule] : d.rule, message: d.message, count: 0 };
    g.count++;
    grouped.set(d.rule, g);
  }
  const tb = await stack.admin.get("/v1/ledger/trial-balance", tbSchema);
  const hubBalance = await stack.rpc.pub.readContract({ address: stack.token, abi: erc20Abi, functionName: "balanceOf", args: [stack.hub] });
  const proof = await proveCall(stack);
  let mcpProof: Summary["mcpProof"] = null;
  if (traffic.sampleTradingCallId) {
    const r = (await stack.trading.mcp.callTool({ name: "prove_receipt", arguments: { callId: traffic.sampleTradingCallId } })) as ToolResult;
    const payload = parseToolPayload(toolText(r)) as { independentlyVerifiedOnchain?: boolean | null } | null;
    mcpProof = { callId: traffic.sampleTradingCallId, verified: r.isError ? false : (payload?.independentlyVerifiedOnchain ?? null) };
  }
  const ov = await stack.admin.get("/v1/overview", z.object({ gasSaved: z.object({ naive: z.string() }).loose() }).loose());
  const saved = naive > used ? naive - used : 0n;
  return {
    network: { chainId: stack.cfg.chainId, live: stack.cfg.live, hub: stack.hub, token: stack.token, rpc: stack.rpc.rpcUrl, confirmTag: stack.cfg.confirmTag },
    calls,
    failedCalls: traffic.failed.length,
    callsPerSec: traffic.ms > 0 ? (traffic.ok / traffic.ms) * 1000 : 0,
    gross,
    net,
    batches,
    transfersOnchain,
    compression: transfersOnchain > 0 ? calls / transfersOnchain : 0,
    gas: { used, naivePerCall, naive, saved, savedPct: naive > 0n ? Number((saved * 10_000n) / naive) / 100 : 0, nodeEstimateNaive: BigInt(ov.gasSaved.naive) },
    denials: [...grouped.values()],
    attacks: traffic.attacks,
    hsp: batches.flatMap((b) =>
      b.netTransfers.map((t) => ({ batch: b.id, index: t.index, from: t.from, to: t.to, amount: t.amount, status: t.hsp?.status ?? "NONE", cosigned: t.hsp?.cosigned ?? false })),
    ),
    trialBalance: { balanced: tb.balanced, balance: tb.balance, journals: tb.journals },
    hubBalance,
    gasless: {
      label: stack.gasless.label,
      address: stack.gasless.address,
      transactions: (await stack.rpc.pub.getTransactionCount({ address: stack.gasless.address })) - stack.gasless.txBefore,
    },
    proof: proof ? { seq: proof.seq, callId: proof.callId, batchId: proof.batchId, proofLength: proof.proofLength, verifiedOnchain: proof.verifiedOnchain, nodeSaid: proof.nodeSaid } : null,
    mcpProof,
    dropped: s.dropped,
    settleMs: s.ms,
    runMs: Date.now() - runStarted,
    dashboard: { url: `http://localhost:${dashboardPort()}`, nodeUrl: stack.nodeUrl, rpcUrl: stack.rpc.rpcUrl },
    names: Object.fromEntries(stack.names),
    marketDataSource: (await stack.priceSource.quote("HSK")).source,
  };
}

export function txLink(chainId: number, hash: string | null): string {
  if (!hash) return "-";
  return explorerTx(chainId, hash) ?? hash;
}
