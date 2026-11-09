/**
 * pnpm demo        one command: chain, deploy, node, providers, mandates, ~500 paid calls, settle, summary, then the
 *                  gateway act (one link paid four ways, refund, screening), the AI agents act with DEMO_AI=1, checks, stop.
 * pnpm demo:stage  the live pitch: same stack, paced and step by step (Enter advances), left running for the dashboard.
 */
import { z } from "zod";
import { formatAmount } from "@payminto/protocol";
import { DemoConfigError, loadDemoConfig, REPO_ROOT, type DemoConfig } from "./config.ts";
import { checkSummary } from "./checks.ts";
import { checkAi, renderAi, runAiAct, type AiResult } from "./ai.ts";
import { checkGateway, runGatewayAct, type GatewayResult } from "./gateway.ts";
import { collectSummary, proveCall, runTraffic, settle, type AttackResult, type SettleOutcome, type Summary, type TrafficResult } from "./scenario.ts";
import { dashboardPort, startStack, type Stack } from "./stack.ts";
import { advance, banner, c, clip, confirmNote, kv, progressBar, renderGatewaySummary, renderSummary, section, short, stageAuto, stageSettleDelayMs, stageStepMs, stepHeader, usdc, waitEnter, waitEnterOr } from "./ui.ts";

const mode = process.argv[2] === "stage" ? "stage" : "run";
const out = (s = "") => process.stdout.write(s + "\n");
const say = (s: string) => out(`  ${c.dim(">")} ${s}`);

let stack: Stack | null = null;
let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  if (stack) {
    out(c.dim("\n  stopping node, providers and anvil..."));
    await Promise.race([stack.stop(), new Promise((r) => setTimeout(r, 8_000))]);
  }
  process.exit(code);
}
let sigints = 0;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (++sigints > 1) process.exit(130); // the anvil watchdog still stops anvil within a second
    void shutdown(130);
  });
}

function printPlan(cfg: DemoConfig) {
  const p = cfg.plan;
  out(section("Plan"));
  out(`  ${cfg.calls} paid calls at concurrency ${cfg.concurrency}${mode === "stage" ? ", paced for the stage" : ""}`);
  out(`  Treasury Agent (SDK): ${p.treasuryMarket} quotes, ${p.treasuryRisk} risk scans, ${p.briefs} research briefs`);
  out(`  Research Writer (agent and provider): buys ${p.briefQuotes} quotes + ${p.briefScans} scan per brief = ${p.briefs * (p.briefQuotes + p.briefScans)} calls`);
  out(`  Trading Agent (MCP tools): ${p.tradingMarket} quotes (one is a poisoned feed), ${p.tradingRisk} risk scans`);
  out(`  attacks: prompt-injected payment to an unlisted wallet, and a call above the per-call cap`);
  const pr = cfg.prices;
  out(`  prices: Market Data ${usdc(pr.market)}, Risk Scan ${usdc(pr.risk)}, Research Writer ${usdc(pr.writer)}`);
  out(`  planned spend (upper bound): ${c.bold(usdc(cfg.spend.total))}  ${c.dim(`treasury ${formatAmount(cfg.spend.treasury)}, trading ${formatAmount(cfg.spend.trading)}, writer ${formatAmount(cfg.spend.writer)}`)}`);
  if (cfg.gatewayKeys) {
    out(`  gateway: merchant Northwind Data, one ${usdc(cfg.gatewayAmounts.link)} link paid by wallet, transfer, x402 exact and an MCP mandate agent; refund; screening; reconciliation report`);
    if (cfg.live) out(`    ${c.dim(`funded testnet wallets; payers spend up to ${usdc(cfg.spend.gateway)}; webhooks ${cfg.webhookUrl ? `to ${cfg.webhookUrl}` : "skipped (no public DEMO_WEBHOOK_URL)"}`)}`);
  } else out(c.dim("  gateway act: off on this live network (DEMO_GATEWAY=1 with its funded wallets turns it on)"));
  if (cfg.ai) {
    out(`  AI agents: ${cfg.ai.provider} ${cfg.ai.model} with the business's own key${cfg.ai.keyHint ? ` (ending ${cfg.ai.keyHint})` : ""}${cfg.ai.baseUrl ? ` at ${cfg.ai.baseUrl}` : ""}`);
    out(`    an ops agent answers from real payments; an AI buyer agent pays an AI skill ${usdc(cfg.ai.skillPrice)} (ceiling ${usdc(cfg.ai.buyerCeiling)}); proof on chain`);
  } else out(c.dim("  AI agents act: off (DEMO_AI=1 with a model key turns it on)"));
  if (cfg.live) out(`  confirmations: ${confirmNote(cfg.confirmTag)}`);
  if (cfg.live) out(`  ${c.yellow(`LIVE NETWORK ${cfg.chainId}: spend cap ${usdc(cfg.maxSpend)} (DEMO_MAX_SPEND_USDC), confirmed by DEMO_LIVE_NETWORK_CONFIRM=yes`)}`);
}

function narrateAttack(a: AttackResult) {
  out(`\n  ${c.red(c.bold("ATTACK"))}  ${c.bold(a.agent)} ${c.dim(`via ${a.via === "mcp" ? "MCP tools" : "SDK"}`)}: ${a.name}`);
  if (a.toolText) out(`    ${c.dim(`tool reply to the model: "${clip(a.toolText, 110)}"`)}`);
  const l1 = a.agentRule ? c.red(c.bold(`REFUSED  ${a.agentRule}`)) : c.red(c.bold("SIGNED"));
  const l2 = a.nodeRule
    ? `${c.red(c.bold(`DENIED   ${a.nodeRule}`))}  ${c.dim(a.ruleText ?? "")}`
    : a.compromisedLocalRule
      ? c.yellow(c.bold(`NOT REACHED - the compromised client refused locally with ${a.compromisedLocalRule}`))
      : c.red(c.bold(`ACCEPTED - this should never happen (${a.message})`));
  out(`    ${c.dim("layer 1  agent SDK, before signing ")}  ${l1}`);
  out(`    ${c.dim("layer 2  clearing node, recorded   ")}  ${l2}`);
  out(`    ${c.green("no money moved")}`);
}

function trafficProgress() {
  const tty = process.stdout.isTTY;
  let last = -1;
  return (p: { done: number; total: number; ok: number; failed: number }) => {
    const line = `  ${progressBar(p.done, p.total)} agent requests  ${c.green(`${p.ok} paid`)}${p.failed ? c.red(`  ${p.failed} failed`) : ""}`;
    if (tty) process.stdout.write(`\r${line}`);
    else if (Math.floor((p.done / p.total) * 10) !== last) {
      last = Math.floor((p.done / p.total) * 10);
      out(line);
    }
  };
}

async function runMode(cfg: DemoConfig) {
  const t0 = Date.now();
  out(section("Boot"));
  stack = await startStack(cfg, { say });
  out(section(`Traffic: ${cfg.calls} paid calls`));
  const pending: AttackResult[] = [];
  const traffic = await runTraffic(stack, { onProgress: trafficProgress(), onAttack: (a) => pending.push(a) });
  out("");
  for (const a of pending) narrateAttack(a);
  out(section("Settle"));
  say("POST /v1/settlements: net every obligation into one settleBatch, debtors co-sign HSP mandates");
  const s = await settle(stack, { say });
  if (s.skipped) throw new Error(`settlement skipped: ${s.skipped}`);
  const summary = await collectSummary(stack, traffic, s, t0);
  out(renderSummary(summary));
  let gateway: GatewayResult | null = null;
  if (stack.gateway) {
    out(section("Gateway: one link, four ways to pay"));
    gateway = await runGatewayAct(stack, { say });
    out(renderGatewaySummary(gateway, cfg.chainId));
  }
  let ai: AiResult | null = null;
  if (stack.ai) {
    out(section("AI agents: the business's own model key, an ops agent, an AI buyer paying an AI skill"));
    ai = await runAiAct(stack, { say, opsMerchantId: gateway?.merchant.id });
    out(renderAi(ai, stack.cfg.chainId));
  }
  return finish(summary, traffic, gateway, ai);
}

function finish(summary: Summary, traffic: TrafficResult, gateway: GatewayResult | null, ai: AiResult | null = null): number {
  const problems = checkSummary(summary, { expectedCalls: stack!.cfg.calls });
  if (traffic.failed.length) problems.push(`${traffic.failed.length} calls failed: ${JSON.stringify(traffic.failed.slice(0, 3))}`);
  const gatewayProblems = gateway ? checkGateway(gateway) : [];
  out(section("Checks"));
  if (problems.length === 0) out(c.green("  all checks passed: denials with rules, transfers < calls, books at zero, proof verified on chain"));
  else for (const p of problems) out(c.red(`  FAIL ${p}`));
  if (gateway) {
    if (gatewayProblems.length === 0) {
      const hooks = gateway.webhooks.mode === "local" ? "every webhook verified" : gateway.webhooks.mode === "public" ? "every webhook delivered" : "webhooks not checked (no public receiver)";
      out(c.green(`  gateway checks passed: four payments paid, balances match the fee breakdowns, forwarders, router and hub at 0, ${hooks}, screening recorded, reconciliation report matches`));
    } else for (const p of gatewayProblems) out(c.red(`  FAIL gateway: ${p}`));
  }
  problems.push(...gatewayProblems);
  if (ai) {
    const aiProblems = checkAi(ai);
    if (aiProblems.length === 0) out(c.green("  AI agents checks passed: connections active, ops agent used merchant tools, the AI buyer paid the AI skill once within its ceiling, receipt proven on chain"));
    else for (const p of aiProblems) out(c.red(`  FAIL AI agents: ${p}`));
    problems.push(...aiProblems);
  }
  out(c.dim(`  node log: ${stack!.logFile}`));
  out(c.dim(`  dashboard login: ${stack!.logins.items.map((l) => l.email).join(", ")} (passwords in ${stack!.logins.file}); the recovery key stopped working after setup`));
  return problems.length ? 1 : 0;
}

const batchList = z.array(z.object({ id: z.string(), status: z.string(), calls: z.number() }).loose());
const previewSchema = z.object({ calls: z.number(), claims: z.number(), transfers: z.number(), compression: z.number(), grossTotal: z.string(), netTotal: z.string(), gross: z.array(z.object({ from: z.string(), to: z.string(), amount: z.string(), calls: z.number() }).loose()), net: z.array(z.object({ from: z.string(), to: z.string(), amount: z.string() }).loose()) }).loose();

const STEPS = 8;

/** network.rpc_url from /v1/info: what the dashboard's wallet code should use (NEXT_PUBLIC_RPC_URL). */
async function publicRpcUrl(st: Stack): Promise<string | null> {
  const info = (await (await fetch(`${st.nodeUrl}/v1/info`)).json()) as { network?: { rpc_url?: string | null } };
  return info.network?.rpc_url ?? null;
}

async function stageMode(cfg: DemoConfig) {
  const t0 = Date.now();
  out(section("Boot (before walking on stage)"));
  stack = await startStack(cfg, { say });
  const st = stack;
  const names = new Map<string, string>([
    [st.addresses.treasury.toLowerCase(), "Treasury Agent"],
    [st.addresses.trading.toLowerCase(), "Trading Agent"],
    [st.addresses.writer.toLowerCase(), "Research Writer"],
    [st.addresses.market.toLowerCase(), "Market Data"],
    [st.addresses.risk.toLowerCase(), "Risk Scan"],
  ]);
  const who = (a: string) => names.get(a.toLowerCase()) ?? short(a);
  const col = (s: string, n = 16) => s.padEnd(n);
  out(section("Dashboard"));
  const rpcUrl = await publicRpcUrl(st);
  out(`  start it in another terminal:  ${c.bold(`NEXT_PUBLIC_NODE_URL=${st.nodeUrl}${rpcUrl ? ` NEXT_PUBLIC_RPC_URL=${rpcUrl}` : ""} pnpm --filter dashboard dev${dashboardPort() !== 3000 ? ` -p ${dashboardPort()}` : ""}`)}`);
  const ownerLogin = st.logins.items[0]!;
  // Printed once, here, so a person can sign in locally; the same login is in the run directory's logins file.
  out(`  open ${c.bold(`${st.logins.dashboardUrl}/login`)}, sign in as ${c.bold(ownerLogin.email)} with password ${c.bold(ownerLogin.password)}, stay on Home`);
  out(c.dim(`  logins saved to ${st.logins.file}${st.gateway ? " (step 8 adds the Northwind Data admin)" : ""}`));
  if (!cfg.live) {
    // The agent key is never printed, not even the public anvil one: the command reads it from the environment.
    out(section("Optional: let Claude spend from the Trading Agent mandate"));
    out(c.dim(`  export PAYMINTO_TRADING_AGENT_KEY=<the Trading Agent key: anvil dev account #3>`));
    out(
      c.dim(
        `  claude mcp add payminto-trading -e NODE_URL=${st.nodeUrl} -e CHAIN_ID=${cfg.chainId} -e RPC_URL=${st.rpc.rpcUrl} -e HUB_ADDRESS=${st.hub} ` +
          `-e AGENT_KEY="$PAYMINTO_TRADING_AGENT_KEY" -e MANDATE_ID=${st.mandates.trading} -e RECEIPT_STORE_PATH=${st.receiptStores.trading} ` +
          `-- node ${REPO_ROOT}/apps/mcp/src/main.ts`,
      ),
    );
    // The real Claude agents (apps/agent) against this node: same key handling, read from the environment.
    out(section("Optional: run the Claude buyer and ops agents against this node"));
    out(c.dim(`  export ANTHROPIC_API_KEY=<your Anthropic API key>   (PAYMINTO_AGENT_MODEL overrides the default claude-opus-5-5)`));
    out(
      c.dim(
        `  NODE_URL=${st.nodeUrl} CHAIN_ID=${cfg.chainId} RPC_URL=${st.rpc.rpcUrl} HUB_ADDRESS=${st.hub} ` +
          `AGENT_KEY="$PAYMINTO_TRADING_AGENT_KEY" MANDATE_ID=${st.mandates.trading} RECEIPT_STORE_PATH=${st.receiptStores.trading} ` +
          `pnpm agent run "Quote HSK and ETH, scan wallet ${st.addresses.treasury} for risk, and write me a short risk note" --max-spend 50000`,
      ),
    );
    out(c.dim(`  export PAYMINTO_MERCHANT_API_KEY=<a business API key: dashboard Developers > API keys${st.gateway ? ", for example for Northwind Data after step 8" : ""}>`));
    out(c.dim(`  NODE_URL=${st.nodeUrl} MERCHANT_API_KEY="$PAYMINTO_MERCHANT_API_KEY" pnpm agent ops "what did we earn today"`));
  }
  if (stageAuto) {
    const settle = stageSettleDelayMs > 0 ? `settles ${(stageSettleDelayMs / 1000).toFixed(0)} s after the netting preview unless Settle now is clicked first` : "waits for Settle now in the dashboard";
    out(c.dim(`\n  auto mode: a step every ${(stageStepMs / 1000).toFixed(1)} s (DEMO_STAGE_STEP_MS); step 4 ${settle} (DEMO_STAGE_SETTLE_DELAY_MS)`));
  }
  await advance("step 1: the Treasury Agent mandate");

  out(stepHeader(1, STEPS, "Mandate", "an owner signs one EIP-712 mandate; the agent can only spend inside it"));
  const p = st.policies.treasury;
  out(
    kv([
      ["agent", `${c.bold("Treasury Agent")}  ${c.dim(st.addresses.treasury)}`],
      ["mandate", c.dim(st.mandates.treasury)],
      ["total cap", c.bold(usdc(st.caps.treasury))],
      ["per call", c.bold(usdc(p.perCallCap))],
      ["daily cap", usdc(p.dailyCap)],
      ["rate limit", `${p.maxCallsPerMinute.toLocaleString("en-US")} calls/min`],
      ["allowed payees", "Market Data, Risk Scan, Research Writer"],
      ["expires", "in 12 h"],
      ["opened on chain", c.dim(st.mandateTx.treasury ?? "-")],
    ]),
  );
  out(`\n  ${c.green("gasless")}  Research Writer signed an EIP-2612 permit; the node opened its mandate with openMandateWithPermit. ${c.bold("Agent sent 0 transactions.")}`);
  await advance("step 2: run the agents");

  out(stepHeader(2, STEPS, `Agents buying`, `${cfg.calls} paid calls, paced; each research brief buys 2 quotes and 1 scan on its own mandate`));
  const pending: AttackResult[] = [];
  const progress = trafficProgress();
  const traffic = await runTraffic(st, {
    pacePerSec: Number(process.env.DEMO_STAGE_PACE ?? 14),
    onProgress: progress,
    onAttack: (a) => {
      out("");
      narrateAttack(a);
      pending.push(a);
    },
  });
  out("");
  out(`\n  ${c.green(c.bold(`${traffic.ok} agent requests paid`))}, ${c.red(c.bold(`${pending.length} attacks blocked`))}, ${c.bold("0 gas")} spent by any agent`);
  await advance("step 3: netting preview");

  out(stepHeader(3, STEPS, "Netting", "every accepted call is an obligation; only the net differences move on chain"));
  const pv = await st.admin.get("/v1/netting/preview", previewSchema);
  out(`  ${c.bold(String(pv.calls))} calls, ${pv.claims} claims, gross ${c.bold(usdc(pv.grossTotal))} across ${pv.gross.length} obligations`);
  out(c.dim(`\n         ${col("payer")}    ${col("payee")} ${"amount".padStart(14)}  calls`));
  for (const g of pv.gross) out(`    ${c.dim("owes")} ${col(who(g.from))} -> ${col(who(g.to))} ${usdc(g.amount).padStart(14)}  ${c.dim(String(g.calls).padStart(5))}`);
  out(`\n  nets to ${c.bold(String(pv.transfers))} transfers, ${c.bold(usdc(pv.netTotal))}:`);
  for (const n of pv.net) out(`    ${c.green("pays")} ${col(who(n.from))} -> ${col(who(n.to))} ${usdc(n.amount).padStart(14)}`);
  out(`\n  ${c.bold(c.green(`${pv.compression.toFixed(1)} calls per on-chain transfer`))}`);

  out(stepHeader(4, STEPS, "Settle", "one settleBatch transaction; debtors co-sign HSP payments; funds move wallet to wallet"));
  const confirmed = async () => (await st.admin.get("/v1/batches", batchList)).some((b) => b.status === "confirmed");
  const prompt = stageAuto
    ? stageSettleDelayMs > 0
      ? c.cyan(`  click Settle now in the dashboard; settling from here in ${(stageSettleDelayMs / 1000).toFixed(0)} s otherwise`)
      : c.cyan("  waiting for Settle now in the dashboard")
    : c.cyan("  click Settle now in the dashboard, or press [Enter] to settle from here ");
  const how = await waitEnterOr(prompt, confirmed, stageAuto ? { autoMs: stageSettleDelayMs } : {});
  let s: SettleOutcome;
  if (how === "enter") {
    say("settling from the terminal (POST /v1/settlements)");
    s = await settle(st, { say });
    if (s.skipped) {
      say(`settlement already running (${s.skipped}); waiting for it`);
      while (!(await confirmed())) await new Promise((r) => setTimeout(r, 500));
    }
  } else say("settled from the dashboard");
  const batches = (await st.admin.get("/v1/batches", batchList)).filter((b) => b.status === "confirmed");
  s = { batchIds: batches.map((b) => b.id as `0x${string}`), dropped: [], ms: 0 };
  const summary = await collectSummary(st, traffic, s, t0);
  out(`  ${c.bold(String(summary.calls))} calls -> ${c.bold(c.green(String(summary.transfersOnchain)))} on-chain transfers, compression ${c.bold(c.green(summary.compression.toFixed(1)))}, gas saved ${c.bold(c.green(`${summary.gas.savedPct.toFixed(1)}%`))}`);
  await advance("step 5: batch detail and HSP");

  out(stepHeader(5, STEPS, "Batch and HSP", "each net transfer is an HSP payment the debtor co-signed; the verifier answers ACCEPT"));
  for (const b of summary.batches)
    out(
      kv([
        ["batch", short(b.id)],
        ["tx", b.txHash ?? "-"],
        ["status", b.status === "confirmed" ? c.green("confirmed at the finality head") : c.yellow(b.status)],
        ["dashboard", c.cyan(`http://localhost:${dashboardPort()}/batches/${b.id}`)],
      ]),
    );
  out("");
  for (const h of summary.hsp) out(`    #${h.index + 1}  ${col(who(h.from))} -> ${col(who(h.to))} ${usdc(h.amount).padStart(14)}  HSP ${h.status === "ACCEPT" ? c.green(c.bold(h.status)) : c.yellow(h.status)}`);
  if (stageAuto) await advance("step 6: prove one call on chain");

  out(stepHeader(6, STEPS, "Receipt proof", "any single call is provable against the receipts root stored on chain"));
  for (;;) {
    const answer = stageAuto ? "" : await waitEnter(c.cyan(`\n  judge picks a call number 1-${summary.calls} (type it, [Enter] for random, "q" to finish) `));
    if (answer.toLowerCase() === "q") break;
    const seq = answer ? Number(answer) : undefined;
    const pr = await proveCall(st, Number.isInteger(seq) ? seq : undefined);
    if (!pr) out(c.yellow("  that one lands in the next batch; pick another"));
    else
      out(
        kv([
          ["call", `#${pr.seq}  ${c.dim(pr.callId)}`],
          ["batch", c.dim(pr.batchId)],
          ["Merkle path", `${pr.proofLength} steps`],
          ["verifyReceipt", pr.verifiedOnchain ? c.green(c.bold("true, verified on chain")) : c.red(c.bold("false"))],
          ["dashboard", c.cyan(`http://localhost:${dashboardPort()}/receipts/${pr.callId}`)],
        ]),
      );
    if (stageAuto || !process.stdin.isTTY) break;
  }
  if (stageAuto) await advance("step 7: the books");

  out(stepHeader(7, STEPS, "Books", "double-entry ledger: every journal balances, the hub holds nothing"));
  out(
    kv([
      ["trial balance", summary.trialBalance.balanced ? c.green(c.bold(`balanced, ${summary.trialBalance.balance} USDC`)) : c.red("UNBALANCED")],
      ["hub token balance", summary.hubBalance === 0n ? c.green(c.bold("0 (non-custodial)")) : c.red(usdc(summary.hubBalance))],
    ]),
  );
  out(renderSummary(summary));

  let gateway: GatewayResult | null = null;
  if (st.gateway) {
    await advance("step 8: the payment gateway");
    out(stepHeader(8, STEPS, "Gateway", "one link for people and agents: wallet, transfer, x402 exact and an MCP mandate agent, each split on chain"));
    gateway = await runGatewayAct(st, { say });
    out(renderGatewaySummary(gateway, cfg.chainId));
    out(`\n  ${c.dim("dashboard")}  ${c.cyan(`http://localhost:${dashboardPort()}/payments`)}  ${c.dim("(open the link page as a person:")} ${c.cyan(gateway.link.url)}${c.dim(")")}`);
  }
  let ai: AiResult | null = null;
  if (st.ai) {
    await advance("step 9: AI agents");
    out(stepHeader(9, STEPS + 1, "AI agents", "the business brings its own model key; an ops agent answers, an AI buyer pays an AI skill, proven on chain"));
    ai = await runAiAct(st, { say, opsMerchantId: gateway?.merchant.id });
    out(renderAi(ai, st.cfg.chainId));
    out(`\n  ${c.dim("dashboard")}  ${c.cyan(`http://localhost:${dashboardPort()}/agents`)}`);
  }
  const code = finish(summary, traffic, gateway, ai);
  // Without a terminal (CI, scripted rehearsal) stage mode exits unless DEMO_STAGE_HOLD=1 keeps the stack up.
  if (process.env.DEMO_STAGE_EXIT === "1" || (!process.stdin.isTTY && process.env.DEMO_STAGE_HOLD !== "1")) return code;
  out(c.bold(`\n  Node and providers keep running for the dashboard (${st.nodeUrl}). Ctrl-C to stop everything.`));
  await new Promise(() => {});
  return code;
}

out(
  banner(
    "Payminto Clearing",
    mode === "stage" ? (stageAuto ? "stage mode - steps advance automatically" : "stage mode - press Enter to advance each step") : "agent-to-agent clearing on HashKey Chain",
  ),
);
let cfg: DemoConfig;
try {
  cfg = loadDemoConfig(process.env);
} catch (err) {
  if (err instanceof DemoConfigError) {
    process.stderr.write(c.red(`\n${err.message}\n`));
    process.exit(2);
  }
  throw err;
}
printPlan(cfg);
try {
  const code = mode === "stage" ? await stageMode(cfg) : await runMode(cfg);
  await shutdown(code);
} catch (err) {
  process.stderr.write(c.red(`\n  demo failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`));
  const st = stack as Stack | null;
  if (st) process.stderr.write(c.dim(`  node log: ${st.logFile}\n`));
  await shutdown(1);
}
