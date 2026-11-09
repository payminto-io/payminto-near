import { createInterface } from "node:readline";
import { formatAmount, networks } from "@payminto/protocol";
import type { GatewayResult } from "./gateway.ts";
import type { Summary } from "./scenario.ts";
import { txLink } from "./scenario.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, "").length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visible(s)));

/** How the node confirms on a live network: its default, or the testnet demo override (said out loud). */
export function confirmNote(tag: "latest" | "safe" | "finalized" | null): string {
  if (tag === "latest") return c.yellow("at the latest head (testnet demo setting DEMO_CONFIRM_TAG=latest; the node's default is the safe head)");
  return `at the ${tag ?? "safe"} head${tag ? " (DEMO_CONFIRM_TAG)" : " (node default)"}`;
}

export const usdc = (atomic: bigint | string) => `${formatAmount(atomic, 6)} USDC`;
export const short = (h: string) => (h.length > 14 ? `${h.slice(0, 6)}..${h.slice(-4)}` : h);
const int = (n: number | bigint) => n.toLocaleString("en-US");

export function banner(title: string, sub: string): string {
  const w = Math.max(visible(title), visible(sub)) + 4;
  const line = "-".repeat(w);
  return [c.cyan(`+${line}+`), c.cyan("|") + "  " + pad(c.bold(title), w - 2) + c.cyan("|"), c.cyan("|") + "  " + pad(c.dim(sub), w - 2) + c.cyan("|"), c.cyan(`+${line}+`)].join("\n");
}

export function section(title: string): string {
  return `\n${c.bold(c.blue(`== ${title} `))}${c.blue("=".repeat(Math.max(4, 64 - title.length)))}`;
}

/** A stage step header: a numbered, bold banner line that reads at a glance on camera. */
export function stepHeader(n: number, total: number, title: string, sub?: string): string {
  const tag = ` STEP ${n}/${total} `;
  const head = useColor ? `\x1b[1;30;46m${tag}\x1b[0m` : `[${tag.trim()}]`;
  const rule = c.cyan("-".repeat(Math.max(4, 58 - title.length)));
  return `\n\n${head} ${c.bold(title)} ${rule}${sub ? `\n  ${c.dim(sub)}` : ""}\n`;
}

/** Cuts long text at a word boundary so a line never ends mid-word. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "")}...`;
}

export function kv(rows: Array<[string, string]>): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${c.dim(k.padEnd(w))}  ${v}`).join("\n");
}

export function progressBar(done: number, total: number, width = 32): string {
  const f = total > 0 ? Math.min(1, done / total) : 0;
  const n = Math.round(f * width);
  return `[${c.green("#".repeat(n))}${c.dim(".".repeat(width - n))}] ${String(done).padStart(String(total).length)}/${total}`;
}

const hspColor = (s: string) => (s === "ACCEPT" || s === "SETTLED" ? c.green(s) : s === "UNSIGNED" ? c.yellow(s) : c.red(s));

export function renderSummary(s: Summary): string {
  const out: string[] = [];
  const net = s.network.live ? `${networks[s.network.chainId]?.chain.name ?? "chain"} (${s.network.chainId})` : "local anvil (31337)";
  out.push(section("Payminto Clearing - run summary"));
  out.push(
    kv([
      ["network", `${net}  ${c.dim(s.network.rpc)}`],
      ...(s.network.live ? ([["confirmations", confirmNote(s.network.confirmTag)]] as Array<[string, string]>) : []),
      ["hub", s.network.hub],
      ["token", s.network.token],
    ]),
  );
  out.push(section("Clearing"));
  const failed = s.failedCalls ? c.red(`  (${s.failedCalls} failed)`) : "";
  out.push(
    kv([
      ["paid calls", `${c.bold(int(s.calls))}${failed}  ${c.dim(`${s.callsPerSec.toFixed(0)} calls/s, zero gas for agents`)}`],
      ["gross", c.bold(usdc(s.gross))],
      ["net moved", `${c.bold(usdc(s.net))}  ${c.dim(`${s.gross > 0n ? ((Number(s.net) / Number(s.gross)) * 100).toFixed(1) : "0"}% of gross`)}`],
      ["batches", `${s.batches.length}${s.settleMs > 0 ? `  ${c.dim(`settled in ${(s.settleMs / 1000).toFixed(1)} s`)}` : ""}`],
      ["on-chain transfers", `${c.bold(String(s.transfersOnchain))}  ${c.dim("NetTransfer events decoded from tx receipts")}`],
      ["compression", c.bold(c.green(`${s.compression.toFixed(1)} calls per on-chain transfer`))],
      ["market data source", c.dim(s.marketDataSource)],
    ]),
  );
  out.push(section("Gas (from tx receipts)"));
  out.push(
    kv([
      ["settlement gas used", `${c.bold(int(s.gas.used))} gas`],
      ["naive, one transfer per call", `${int(s.gas.naive)} gas  ${c.dim(`= ${int(s.calls)} x ${int(s.gas.naivePerCall)} (eth_estimateGas of one ERC-20 transfer)`)}`],
      ["saved", c.bold(c.green(`${int(s.gas.saved)} gas (${s.gas.savedPct.toFixed(1)}%)`))],
    ]),
  );
  out.push(section("Settlement transactions"));
  for (const b of s.batches) {
    const ok = b.status === "confirmed" ? c.green(b.status) : c.red(b.status);
    out.push(`  ${c.dim("batch")} ${short(b.id)}  ${ok}  ${b.calls} calls, ${b.claims} claims, ${b.transfers} transfers, reconciled ${b.reconciled ? c.green("yes") : c.red(String(b.reconciled))}`);
    out.push(`  ${c.dim("tx")}    ${txLink(s.network.chainId, b.txHash)}`);
  }
  if (s.dropped.length) for (const d of s.dropped) out.push(`  ${c.yellow("dropped")} ${short(d.mandateId)} -> ${short(d.payee)}: ${d.reason}`);
  out.push(section("Net transfers and HSP"));
  const who = (a: string) => pad(s.names[a.toLowerCase()] ?? short(a), 16);
  for (const h of s.hsp) {
    out.push(`  #${h.index + 1}  ${who(h.from)} -> ${who(h.to)} ${pad(usdc(h.amount), 14)}  HSP ${pad(hspColor(h.status), 8)} ${h.cosigned ? c.dim("co-signed by debtor") : c.yellow("not co-signed")}`);
  }
  out.push(section("Denials (recorded by the node)"));
  if (s.denials.length === 0) out.push(c.dim("  none"));
  for (const d of s.denials) out.push(`  ${c.red(d.rule.padEnd(18))} x${d.count}  ${d.ruleText}`);
  for (const a of s.attacks) {
    const l1 = a.agentRule ? c.red(`agent refused ${a.agentRule}`) : c.red("agent SIGNED");
    const l2 = a.nodeRule
      ? c.red(`node denied ${a.nodeRule}`)
      : a.compromisedLocalRule
        ? c.yellow(`never reached the node (refused locally ${a.compromisedLocalRule})`)
        : c.red("node ACCEPTED");
    out.push(`  ${c.dim("attack")} ${a.agent} via ${a.via.toUpperCase()}: ${a.name} -> ${l1}, compromised runtime -> ${l2}`);
    if (a.toolText) out.push(`         ${c.dim(`MCP tool error: "${clip(a.toolText, 150)}"`)}`);
  }
  out.push(section("Proof and books"));
  const proofRows: Array<[string, string]> = [];
  if (s.proof) {
    const v = s.proof.verifiedOnchain ? c.green("true") : c.red("false");
    proofRows.push([`call #${s.proof.seq}`, `${short(s.proof.callId)} in batch ${short(s.proof.batchId)}, ${s.proof.proofLength}-step Merkle path, ClearingHub.verifyReceipt = ${c.bold(v)}`]);
  } else proofRows.push(["proof", c.red("no settled call to prove")]);
  if (s.mcpProof) proofRows.push(["MCP prove_receipt", `${short(s.mcpProof.callId)} -> verified on chain: ${s.mcpProof.verified ? c.green("true") : c.red(String(s.mcpProof.verified))}`]);
  proofRows.push(
    ["trial balance", s.trialBalance.balanced && s.trialBalance.balance === "0" ? c.green(`balanced, ${s.trialBalance.journals} journals, balance 0`) : c.red(`UNBALANCED ${s.trialBalance.balance}`)],
    ["hub token balance", s.hubBalance === 0n ? c.green("0 (non-custodial: wallet to wallet)") : c.red(usdc(s.hubBalance))],
    [
      "gasless onboarding",
      s.gasless.transactions === 0
        ? c.green(`${s.gasless.label}: EIP-2612 permit, agent sent 0 transactions`)
        : c.red(`${s.gasless.label}: agent sent ${s.gasless.transactions} transactions`),
    ],
  );
  out.push(kv(proofRows));
  out.push(section("Dashboard"));
  const port = new URL(s.dashboard.url).port;
  out.push(kv([["node", s.dashboard.nodeUrl], ["dashboard", `${s.dashboard.url}  ${c.dim(`(NEXT_PUBLIC_NODE_URL=${s.dashboard.nodeUrl} NEXT_PUBLIC_RPC_URL=${s.dashboard.rpcUrl} pnpm --filter dashboard dev${port && port !== "3000" ? ` -p ${port}` : ""})`)}`]]));
  out.push(c.dim(`\n  total run time ${(s.runMs / 1000).toFixed(1)} s`));
  return out.join("\n");
}

export function renderGatewaySummary(r: GatewayResult, chainId?: number): string {
  const out: string[] = [];
  const plan = r.merchant.plan;
  const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")} %`;
  out.push(section("Payminto Gateway - run summary"));
  out.push(
    kv([
      ["merchant", `${c.bold(r.merchant.name)}  ${c.dim(r.merchant.id)}  payout ${short(r.merchant.payout)}`],
      ["fee plan", `${plan.name}: ${pct(plan.platform_fee_bps)} + ${usdc(plan.platform_fee_fixed)}; deposit fee ${usdc(r.merchant.deposit.fee_fixed)} paid by the ${r.merchant.deposit.bearer}`],
      ["one link", `${c.bold(r.link.url)}  ${c.dim(`price ${usdc(r.link.amount)}`)}`],
      ["agents pay", c.dim(r.link.payUrl)],
    ]),
  );
  out.push("");
  const head = `  ${pad("method", 8)} ${pad("payer", 17)} ${pad("paid", 12)} ${pad("fee", 11)} ${pad("net", 12)} ${pad("status", 8)} tx`;
  out.push(c.dim(head));
  for (const p of r.payments) {
    const status = p.status === "paid" ? c.green(p.status) : c.red(p.status);
    const tx = p.method === "voucher" ? `batch ${p.batchId ? short(p.batchId) : "-"}` : p.tx ? short(p.tx) : "-";
    out.push(`  ${pad(c.bold(p.method), 8)} ${pad(p.payer, 17)} ${pad(usdc(p.amountDue), 12)} ${pad(usdc(p.fee), 11)} ${pad(usdc(p.net), 12)} ${pad(status, 8)} ${c.dim(tx)}`);
  }
  const b = r.balances;
  const w = r.webhooks;
  const verified = w.received.filter((x) => x.verified).length;
  const types = [...new Set(w.received.map((x) => x.type))].join(", ");
  const ok = (v: boolean, s: string, bad = s) => (v ? c.green(s) : c.red(bad));
  out.push("");
  out.push(
    kv([
      ["platform fees earned", `${c.bold(usdc(b.platformEarned))}  ${c.dim(r.payments.map((p) => `${p.method} ${usdc(p.fee)}`).join(", "))}`],
      ["refund", `${usdc(r.refund.amount)} of ${short(r.refund.paymentId)} back to the payer, signed by the payout, relayed through the router: ${ok(r.refund.status === "succeeded", r.refund.status)}, payout sent ${r.refund.payoutTransactions} tx  ${c.dim(r.refund.txHash ? short(r.refund.txHash) : "-")}`],
      ["screening", `${short(r.screening.payer)} on the deny list: ${ok(r.screening.httpStatus === 403, `refused ${r.screening.code} ${r.screening.rule}`, `HTTP ${r.screening.httpStatus}`)}, decision ${ok(r.screening.recorded, "recorded", "missing")}`],
      ["merchant balance", `${ok(b.merchantDelta === b.expectedMerchantDelta, `+${usdc(b.merchantDelta)}`)}  ${c.dim(`= nets ${usdc(b.expectedMerchantDelta + r.refund.amount)} - refund ${usdc(r.refund.amount)}`)}`],
      ["platform balance", `${ok(b.platformDelta === b.expectedPlatformDelta, `+${usdc(b.platformDelta)}`)}  ${c.dim("= sum of fee_total")}`],
      ["forwarders", `${ok(b.forwarders.every((f) => f.balance === 0n), `${b.forwarders.length} flushed, 0 left`, "NOT EMPTY")}; router ${ok(b.router === 0n, "0", usdc(b.router))}; hub ${ok(b.hub === 0n, "0", usdc(b.hub))}`],
      [
        "webhooks",
        w.mode === "local"
          ? `${w.delivered} delivered, ${ok(verified === w.received.length && w.received.length > 0, `${verified}/${w.received.length} verified with constructEvent`)}  ${c.dim(types)}`
          : w.mode === "public"
            ? `${ok(w.missing.length === 0 && w.deliveriesNotOk === 0, `${w.delivered} delivered to DEMO_WEBHOOK_URL`, `${w.delivered} delivered, missing ${w.missing.join(", ")}`)}`
            : c.dim("skipped: no public receiver (DEMO_WEBHOOK_URL); the node refuses private webhook targets on public chains"),
      ],
      [
        "reconciliation",
        r.report
          ? `${ok(r.report.paid === 4 && r.report.net === r.report.expectedNet && r.report.ledgerMatches, `${r.report.paid} paid, net ${usdc(r.report.net)}, refunds ${usdc(r.report.refunds)}, ledger matches`, `net ${usdc(r.report.net)} vs ${usdc(r.report.expectedNet)}`)}  ${c.dim(`CSV ${r.report.csvRows} rows`)}`
          : c.red("missing"),
      ],
      [
        "proof",
        r.proof
          ? `${short(r.proof.paymentId)} (${r.proof.method}): tx ${ok(r.proof.finality === "final", r.proof.finality)}, Transfer to the forwarder ${ok(r.proof.forwarderTransfer, "yes", "no")}, AuthorizationUsed by payer ${ok(r.proof.authorizedByPayer, "yes", "no")}, order hash ${ok(r.proof.orderHashMatches, "recomputed", "MISMATCH")}`
          : c.red("missing"),
      ],
    ]),
  );
  if (chainId !== undefined && r.txs.length) {
    out.push(section("Gateway transactions"));
    for (const t of r.txs) out.push(`  ${pad(t.what, 58)} ${txLink(chainId, t.hash)}`);
  }
  out.push(c.dim(`\n  gateway act ${(r.ms / 1000).toFixed(1)} s`));
  return out.join("\n");
}

/**
 * DEMO_STAGE_AUTO=1 advances every stage step on a timer (DEMO_STAGE_STEP_MS, default 4000) so a film can be recorded
 * without touching the keyboard; Enter still skips ahead when stdin is a terminal.
 */
export const stageAuto = process.env.DEMO_STAGE_AUTO === "1";
const msEnv = (name: string, fallback: number) => {
  const v = process.env[name];
  const n = v === undefined || v === "" ? fallback : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const stageStepMs = Math.max(0, msEnv("DEMO_STAGE_STEP_MS", 4000));
/** Auto mode only: how long the pre-settle state stays up for a dashboard click; 0 or less waits for the dashboard. */
export const stageSettleDelayMs = msEnv("DEMO_STAGE_SETTLE_DELAY_MS", 20_000);

const secs = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** Next stage step: Enter in manual mode, a timer (or Enter) in auto mode. */
export function advance(next: string): Promise<string> {
  if (!stageAuto) return waitEnter(c.cyan(`\n  [Enter] ${next} `));
  process.stdout.write(c.dim(`\n  next: ${next} (auto, ${secs(stageStepMs)})\n`));
  return raceEnter(stageStepMs).then(() => "");
}

/** Resolves after `ms`, or earlier on Enter when stdin is a terminal. */
function raceEnter(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin }) : null;
    const done = () => {
      clearTimeout(timer);
      rl?.close();
      resolve();
    };
    const timer = setTimeout(done, ms);
    rl?.once("line", done);
  });
}

/** Stage mode: waits for Enter (or returns at once when stdin is not a terminal). */
export function waitEnter(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${prompt}\n`);
    return Promise.resolve("");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Waits for Enter, or resolves early when `poll` returns true (checked every `everyMs`).
 * With `autoMs` (auto mode) it also resolves as "enter" after that long; `autoMs <= 0` waits for `poll` (or Enter) only.
 */
export function waitEnterOr(prompt: string, poll: () => Promise<boolean>, opts: { everyMs?: number; autoMs?: number } = {}): Promise<"enter" | "poll"> {
  const everyMs = opts.everyMs ?? 500;
  return new Promise((resolve) => {
    let finished = false;
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    let auto: ReturnType<typeof setTimeout> | null = null;
    const finish = (how: "enter" | "poll") => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (auto) clearTimeout(auto);
      rl?.close();
      if (how === "poll") process.stdout.write("\n");
      resolve(how);
    };
    const timer = setInterval(() => {
      poll().then((ok) => ok && finish("poll"), () => {});
    }, everyMs);
    if (opts.autoMs !== undefined) {
      if (opts.autoMs > 0) auto = setTimeout(() => finish("enter"), opts.autoMs);
      if (rl) rl.question(prompt, () => finish("enter"));
      else process.stdout.write(`${prompt}\n`);
      return;
    }
    if (rl) rl.question(prompt, () => finish("enter"));
    else {
      process.stdout.write(`${prompt}\n`);
      finish("enter");
    }
  });
}
