/**
 * The AI agents act (DEMO_AI=1): real merchant AI agents on the same stack, with the business's own model key.
 * A business adds its AI connection, creates a back-office (ops) agent and a paid skill, the ops agent answers from the
 * business's real data, and an AI buyer agent (the payminto-agent runtime with the wallet MCP server, spending from the
 * Treasury Agent's mandate) discovers the skill, pays for one call with a voucher and gets the brief. The batch settles
 * and the skill call's receipt is proven on chain.
 */
import type { Provider } from "@payminto/models";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./config.ts";
import { proveCall, settle, txLink, type SettleOutcome } from "./scenario.ts";
import type { Stack } from "./stack.ts";
import { c, clip, kv, section, short, usdc } from "./ui.ts";

type Say = (s: string) => void;

const SKILL_SLUG = "market-brief";
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const LIMITS = { max_turns: 8, max_output_tokens: 4_000, timeout_seconds: 120 };
const MONTHLY_TOKEN_LIMIT = 200_000;

export const OPS_QUESTION =
  "What did we earn today, and which payments are still unpaid? Then request a refund of 0.01 USDC on the smallest paid payment, if there is one, with the reason 'demo'.";
export const BUYER_TASK =
  "Use list_paid_services to find Market Data and the HashKey market brief skill. " +
  "Step 1: buy one HSK spot quote from Market Data with call_paid_service (GET, query {\"symbol\": \"HSK\"}), and call nothing else in that turn. " +
  "Step 2: only after you have read Market Data's response, buy exactly one brief from the skill with call_paid_service (POST, body {\"input\": \"HSK treasury brief. Live quote: <Market Data's response JSON, copied exactly>\"}). " +
  "Never make up a quote or call both services in the same turn. " +
  "Then write a three-sentence risk note for a treasury team based on the brief, and say what you spent on each call.";
/** The skill's own instructions: it has no data feed, so it works only from the figures its buyer sends. */
export const SKILL_INSTRUCTIONS =
  "Write the brief only from the figures in the input. " +
  "Never state a percentage, trend, price change, volume, market cap or past price unless that exact figure is in the input; a model's memory of the market is out of date and must not be presented as fact. " +
  "Give the spot price with its source and time, two risks for a treasury holding HSK that follow from holding a single volatile token (described without invented figures), and one action. " +
  "If the input has no figures, say which figures you need.";

const connectionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    key_hint: z.string().nullable(),
    last_error: z.string().nullable(),
    verification: z.object({ ok: z.boolean() }).loose(),
  })
  .loose();
const agentSchema = z.object({ id: z.string(), kind: z.string(), slug: z.string().nullable().optional() }).loose();
const runSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    input: z.string().nullable().optional(),
    result: z.object({ answer: z.string() }).loose().nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), model: z.string().nullable() }).loose(),
    skill_call: z.object({ call_id: z.string().nullable(), payer: z.string().nullable() }).nullable(),
  })
  .loose();
const eventsSchema = z.object({ items: z.array(z.object({ seq: z.number(), type: z.string(), data: z.record(z.string(), z.unknown()) }).loose()) });
const merchantsSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), payout: z.string().nullable() }).loose()) });
const callsSchema = z.object({ items: z.array(z.object({ id: z.string(), seq: z.number(), status: z.string(), payee: z.string(), amount: z.string() }).loose()) });
const batchSchema = z.object({ id: z.string(), txHash: z.string().nullable() }).loose();
/** The JSON `payminto-agent run --json` prints (apps/agent RunResult). */
const buyerSchema = z
  .object({
    status: z.string(),
    answer: z.string(),
    provider: z.string(),
    model: z.string(),
    turns: z.number(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).loose(),
    toolCalls: z.array(z.object({ name: z.string(), isError: z.boolean(), summary: z.string() }).loose()),
    spend: z
      .object({
        ceilingAtomic: z.string().nullable(),
        spentAtomic: z.string(),
        receipts: z.array(z.object({ callId: z.string(), service: z.string().nullable(), payee: z.string(), amountAtomic: z.string() }).loose()),
        refusals: z.array(z.object({ rule: z.string() }).loose()),
      })
      .loose()
      .nullable(),
    note: z.string().nullable(),
  })
  .loose();

export type AiRun = {
  id: string;
  status: string;
  answer: string;
  error: string | null;
  tokens: { input: number; output: number };
  model: string | null;
  toolCalls: Array<{ name: string; isError: boolean }>;
  /** What the run was asked: for the skill, the buyer's input including the quote it bought. */
  input: string;
};

export type AiResult = {
  provider: string;
  model: string;
  connections: Array<{ merchant: string; id: string; status: string; keyHint: string | null; verified: boolean; error: string | null }>;
  ops: AiRun & { merchant: string };
  skill: { agentId: string; url: string; price: bigint; payee: string; run: AiRun | null };
  buyer: {
    exitCode: number | null;
    status: string;
    answer: string;
    tokens: { input: number; output: number };
    toolCalls: Array<{ name: string; isError: boolean; summary: string }>;
    ceiling: bigint;
    spent: bigint;
    receipts: Array<{ callId: string; service: string | null; payee: string; amount: bigint }>;
    refusals: string[];
    log: string;
    error: string | null;
  };
  settlement: SettleOutcome;
  skillCall: { id: string; seq: number; status: string; amount: bigint } | null;
  proof: { callId: string; batchId: string; verifiedOnchain: boolean; txHash: string | null } | null;
  /** Every on-chain transaction of the act, as explorer links where the chain has an explorer. */
  txs: string[];
};

/** A business-scoped call through the platform owner's session, with Merchant-Id. Errors carry codes, never keys. */
async function api<T extends z.ZodType>(stack: Stack, merchantId: string, method: "GET" | "POST", path: string, schema: T, body?: unknown): Promise<z.output<T>> {
  const res = await stack.session.fetch(`${stack.nodeUrl}${path}`, {
    method,
    headers: { "merchant-id": merchantId, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`.trim());
  return schema.parse(json);
}

async function runToEnd(stack: Stack, merchantId: string, runId: string, timeoutMs = 240_000): Promise<AiRun> {
  const deadline = Date.now() + timeoutMs;
  let run = await api(stack, merchantId, "GET", `/v1/agent-runs/${runId}`, runSchema);
  while (!TERMINAL.has(run.status) && Date.now() < deadline) run = await api(stack, merchantId, "GET", `/v1/agent-runs/${runId}?wait=30`, runSchema);
  const events = await api(stack, merchantId, "GET", `/v1/agent-runs/${runId}/events`, eventsSchema);
  return {
    id: run.id,
    status: run.status,
    answer: run.result?.answer ?? "",
    input: run.input ?? "",
    error: run.error_code ? `${run.error_code}: ${run.error_message ?? ""}` : null,
    tokens: { input: run.usage.input_tokens, output: run.usage.output_tokens },
    model: run.usage.model,
    toolCalls: events.items.filter((e) => e.type === "tool_result").map((e) => ({ name: String(e.data.name), isError: e.data.is_error === true })),
  };
}

/** The variable the buyer runtime (apps/agent KEY_ENV) reads each provider's key from. */
const BUYER_KEY_ENV = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai_compatible: "PAYMINTO_AGENT_API_KEY",
  replicate: "REPLICATE_API_TOKEN",
} as const satisfies Record<Provider, string>;

/** Runs the real buyer runtime (`payminto-agent run --json`) as its own process, like an agent team would. */
async function runBuyer(stack: Stack): Promise<AiResult["buyer"]> {
  const ai = stack.cfg.ai!;
  const log = join(stack.runDir, "ai-buyer.log");
  const modelEnv: Record<string, string> = { PAYMINTO_AGENT_PROVIDER: ai.provider, PAYMINTO_AGENT_MODEL: ai.model };
  if (ai.baseUrl) modelEnv.PAYMINTO_AGENT_BASE_URL = ai.baseUrl;
  if (ai.apiKey) modelEnv[BUYER_KEY_ENV[ai.provider]] = ai.apiKey;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...modelEnv,
    PAYMINTO_AGENT_MAX_TURNS: String(LIMITS.max_turns),
    // The business's key is used sparingly: the buyer gets the same output budget as the node's agents.
    PAYMINTO_AGENT_MAX_OUTPUT_TOKENS: String(LIMITS.max_output_tokens),
    PAYMINTO_AGENT_MAX_SPEND_ATOMIC: ai.buyerCeiling.toString(),
    // The wallet MCP server the runtime starts gets only these (never the model key).
    NODE_URL: stack.nodeUrl,
    CHAIN_ID: String(stack.cfg.chainId),
    RPC_URL: stack.rpc.rpcUrl,
    HUB_ADDRESS: stack.hub,
    AGENT_KEY: stack.cfg.keys.treasury,
    MANDATE_ID: stack.mandates.treasury,
    TRUSTED_NODE: stack.addresses.operator,
    MAX_PRICE_ATOMIC: ai.skillPrice.toString(),
    // Processes sharing an agent key must share its receipt store.
    RECEIPT_STORE_PATH: stack.receiptStores.treasury,
  };
  const cli = join(REPO_ROOT, "apps", "agent", "src", "cli.ts");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "run", "--json", BUYER_TASK], { env, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const file = createWriteStream(log);
  child.stderr.pipe(file);
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  await new Promise<void>((r) => file.end(r));
  const empty = { exitCode, status: "error", answer: "", tokens: { input: 0, output: 0 }, toolCalls: [], ceiling: ai.buyerCeiling, spent: 0n, receipts: [], refusals: [], log };
  let parsed: z.output<typeof buyerSchema>;
  try {
    parsed = buyerSchema.parse(JSON.parse(stdout));
  } catch {
    return { ...empty, error: `payminto-agent exited ${exitCode} without a run result (see ${log})` };
  }
  return {
    exitCode,
    status: parsed.status,
    answer: parsed.answer,
    tokens: { input: parsed.usage.inputTokens, output: parsed.usage.outputTokens },
    toolCalls: parsed.toolCalls.map((t) => ({ name: t.name, isError: t.isError, summary: t.summary })),
    ceiling: BigInt(parsed.spend?.ceilingAtomic ?? ai.buyerCeiling),
    spent: BigInt(parsed.spend?.spentAtomic ?? "0"),
    receipts: (parsed.spend?.receipts ?? []).map((r) => ({ callId: r.callId, service: r.service, payee: r.payee, amount: BigInt(r.amountAtomic) })),
    refusals: (parsed.spend?.refusals ?? []).map((r) => r.rule),
    log,
    error: parsed.note,
  };
}

/**
 * The act. `opsMerchantId` is the business whose back office the ops agent runs (locally Northwind Data, which the
 * gateway act gave real payments); by default it is the business that sells the skill.
 */
export async function runAiAct(stack: Stack, o: { say?: Say; opsMerchantId?: string } = {}): Promise<AiResult> {
  const say = o.say ?? (() => {});
  const ai = stack.cfg.ai;
  if (!ai || !stack.ai) throw new Error("the AI act needs DEMO_AI=1");
  const payee = stack.ai.skillPayee.toLowerCase();
  const merchants = (await stack.admin.get("/v1/merchants", merchantsSchema)).items;
  const seller = merchants.find((m) => m.payout?.toLowerCase() === payee);
  if (!seller) throw new Error(`no business on the node is paid at ${stack.ai.skillPayee}`);
  const opsMerchant = merchants.find((m) => m.id === (o.opsMerchantId ?? seller.id)) ?? seller;

  // ---------------------------------------------------------------- each business adds its own AI connection
  const connections: AiResult["connections"] = [];
  const connectionFor = new Map<string, string>();
  for (const m of [seller, opsMerchant].filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i)) {
    const conn = await api(stack, m.id, "POST", "/v1/ai/connections", connectionSchema, {
      provider: ai.provider,
      label: `${m.name} ${ai.provider === "openai" ? "OpenAI" : ai.provider}`,
      api_key: ai.apiKey,
      base_url: ai.baseUrl,
      default_model: ai.model,
      monthly_token_limit: MONTHLY_TOKEN_LIMIT,
    });
    connections.push({ merchant: m.name, id: conn.id, status: conn.status, keyHint: conn.key_hint, verified: conn.verification.ok, error: conn.last_error });
    connectionFor.set(m.id, conn.id);
    say(`${m.name} added its own ${ai.provider} key (ending ${conn.key_hint ?? "-"}): connection ${conn.id} is ${conn.status}${conn.verification.ok ? ", verified" : `, ${conn.last_error ?? "not verified"}`}`);
  }

  // ---------------------------------------------------------------- agents
  const ops = await api(stack, opsMerchant.id, "POST", "/v1/agents", agentSchema, {
    kind: "ops",
    name: "Back office",
    description: "Answers questions about earnings, payments and refunds.",
    connection_id: connectionFor.get(opsMerchant.id),
    limits: LIMITS,
  });
  const skill = await api(stack, seller.id, "POST", "/v1/agents", agentSchema, {
    kind: "skill",
    name: "HashKey market brief",
    description: "A short HSK market and risk brief for treasury teams, written by an AI model.",
    connection_id: connectionFor.get(seller.id),
    slug: SKILL_SLUG,
    price: ai.skillPrice.toString(),
    input_hint: "What to brief on, with the figures to use, for example: HSK treasury brief. Live quote: {...}",
    instructions: SKILL_INSTRUCTIONS,
    limits: LIMITS,
  });
  const skillUrl = `${stack.nodeUrl}/v1/skills/${SKILL_SLUG}`;
  say(`${opsMerchant.name} created the ops agent ${ops.id}; ${seller.name} sells the skill ${skillUrl} at ${usdc(ai.skillPrice)} per call`);

  // ---------------------------------------------------------------- ops agent: the back office, in plain words
  const queued = await api(stack, opsMerchant.id, "POST", `/v1/agents/${ops.id}/runs`, runSchema, { input: OPS_QUESTION });
  say(`ops agent run ${queued.id} queued; the node's run worker picks it up and calls ${ai.provider} with ${opsMerchant.name}'s key`);
  const opsRun = await runToEnd(stack, opsMerchant.id, queued.id);
  say(`ops agent ${opsRun.status}: ${opsRun.toolCalls.map((t) => t.name).join(", ") || "no tool calls"} (${opsRun.tokens.input} in, ${opsRun.tokens.output} out tokens)`);

  // ---------------------------------------------------------------- AI buyer agent pays the AI skill
  say(`AI buyer agent (payminto-agent run, ${ai.provider} ${ai.model}) on the Treasury Agent's mandate, ceiling ${usdc(ai.buyerCeiling)}`);
  const buyer = await runBuyer(stack);
  say(`AI buyer agent ${buyer.status}: spent ${usdc(buyer.spent)} on ${buyer.receipts.length} call(s)${buyer.refusals.length ? `, refused ${buyer.refusals.join(", ")}` : ""}`);
  const skillRuns = await api(stack, seller.id, "GET", `/v1/agent-runs?agent_id=${skill.id}`, z.object({ items: z.array(runSchema) }).loose());
  const lastSkillRun = skillRuns.items[0];
  const skillRun = lastSkillRun ? await runToEnd(stack, seller.id, lastSkillRun.id) : null;

  // ---------------------------------------------------------------- settle and prove the skill call on chain
  const settlement = await settle(stack, { say });
  const calls = (await stack.admin.get("/v1/calls?limit=200", callsSchema)).items.filter((x) => x.payee.toLowerCase() === payee);
  const skillCall = calls[0] ? { id: calls[0].id, seq: calls[0].seq, status: calls[0].status, amount: BigInt(calls[0].amount) } : null;
  const proved = skillCall?.status === "settled" ? await proveCall(stack, skillCall.seq) : null;
  const batches = await Promise.all(settlement.batchIds.map((id) => stack.admin.get(`/v1/batches/${id}`, batchSchema)));
  const txs = batches.flatMap((b) => (b.txHash ? [txLink(stack.cfg.chainId, b.txHash)] : []));
  say(`settled ${settlement.batchIds.length} batch(es); skill call ${skillCall ? `#${skillCall.seq} ${skillCall.status}` : "not found"}${proved ? `, receipt proof verified on chain: ${proved.verifiedOnchain}` : ""}`);

  return {
    provider: ai.provider,
    model: ai.model,
    connections,
    ops: { ...opsRun, merchant: opsMerchant.name },
    skill: { agentId: skill.id, url: skillUrl, price: ai.skillPrice, payee: stack.ai.skillPayee, run: skillRun },
    buyer,
    settlement,
    skillCall,
    proof: proved ? { callId: proved.callId, batchId: proved.batchId, verifiedOnchain: proved.verifiedOnchain, txHash: proved.txHash } : null,
    txs,
  };
}

/** What the act promises; the CLI prints it and the test asserts it. */
export function checkAi(r: AiResult): string[] {
  const p: string[] = [];
  for (const conn of r.connections) if (conn.status !== "active") p.push(`${conn.merchant}'s AI connection is ${conn.status}${conn.error ? `: ${conn.error}` : ""}`);
  if (r.ops.status !== "succeeded") p.push(`ops agent run ${r.ops.status}${r.ops.error ? ` (${r.ops.error})` : ""}`);
  if (r.ops.toolCalls.length === 0) p.push("ops agent answered without calling a merchant tool");
  if (!r.skill.run || r.skill.run.status !== "succeeded") p.push(`skill run ${r.skill.run?.status ?? "missing"}${r.skill.run?.error ? ` (${r.skill.run.error})` : ""}`);
  if (r.buyer.status !== "completed") p.push(`AI buyer agent ${r.buyer.status}${r.buyer.error ? ` (${r.buyer.error})` : ""}`);
  const toSkill = r.buyer.receipts.filter((x) => x.payee.toLowerCase() === r.skill.payee.toLowerCase());
  if (toSkill.length !== 1) p.push(`AI buyer agent paid the skill ${toSkill.length} times, expected exactly once`);
  else if (toSkill[0]!.amount !== r.skill.price) p.push(`AI buyer agent paid ${toSkill[0]!.amount} for the skill, its price is ${r.skill.price}`);
  // The brief is only as good as its figures: the buyer must buy a live quote before it buys the brief.
  if (r.buyer.receipts.length - toSkill.length < 1) p.push("AI buyer agent bought no market data before the brief (BUYER_TASK asks for one quote first)");
  // Market Data puts the paid call's id in its response, which no model can guess: a brief whose input lacks it was
  // written from a quote the buyer made up (for example by calling both services in one turn).
  else if (r.skill.run && !r.buyer.receipts.some((x) => x.payee.toLowerCase() !== r.skill.payee.toLowerCase() && r.skill.run!.input.includes(x.callId))) {
    p.push("the AI skill's input does not carry the receipt of the quote the buyer bought, so the brief is not grounded in it");
  }
  if (r.buyer.spent > r.buyer.ceiling) p.push(`AI buyer agent spent ${r.buyer.spent}, above its ceiling ${r.buyer.ceiling}`);
  if (!r.skillCall || r.skillCall.status !== "settled") p.push(`skill call ${r.skillCall ? r.skillCall.status : "not recorded"}, expected settled`);
  if (!r.proof?.verifiedOnchain) p.push("skill call receipt not verified on chain");
  return p;
}

export function renderAi(r: AiResult, chainId: number): string {
  const out: string[] = [];
  out.push(section("AI agents - run summary"));
  out.push(
    kv([
      ["model", `${c.bold(r.provider)} ${r.model}  ${c.dim("each business's own key, sealed in the node's database")}`],
      ...r.connections.map((x): [string, string] => [`connection`, `${x.merchant}: ${x.status === "active" ? c.green(x.status) : c.red(x.status)}  key ...${x.keyHint ?? "-"}  ${c.dim(x.id)}`]),
      ["ops agent", `${r.ops.status === "succeeded" ? c.green(r.ops.status) : c.red(r.ops.status)}  tools ${r.ops.toolCalls.map((t) => t.name).join(", ") || "-"}  ${c.dim(`${r.ops.tokens.input} in / ${r.ops.tokens.output} out tokens`)}`],
      ["ops answer", clip(r.ops.answer.replace(/\s+/g, " "), 160)],
      ["skill", `${r.skill.url}  ${usdc(r.skill.price)} per call, paid to ${short(r.skill.payee)}`],
      ["skill run", r.skill.run ? `${r.skill.run.status === "succeeded" ? c.green(r.skill.run.status) : c.red(r.skill.run.status)}  ${c.dim(`${r.skill.run.tokens.input} in / ${r.skill.run.tokens.output} out tokens`)}` : c.red("none")],
      ["buyer agent", `${r.buyer.status === "completed" ? c.green(r.buyer.status) : c.red(r.buyer.status)}  tools ${r.buyer.toolCalls.map((t) => t.name).join(", ") || "-"}  ${c.dim(`${r.buyer.tokens.input} in / ${r.buyer.tokens.output} out tokens`)}`],
      ["buyer spent", `${usdc(r.buyer.spent)} of a ${usdc(r.buyer.ceiling)} ceiling on ${r.buyer.receipts.length} call(s)${r.buyer.refusals.length ? `, refused ${r.buyer.refusals.join(", ")}` : ""}`],
      ["buyer answer", clip(r.buyer.answer.replace(/\s+/g, " "), 160)],
      ["skill call", r.skillCall ? `#${r.skillCall.seq} ${r.skillCall.status} ${usdc(r.skillCall.amount)}` : c.red("not recorded")],
      ["receipt proof", r.proof ? (r.proof.verifiedOnchain ? c.green(`verifyReceipt true on chain, batch ${short(r.proof.batchId)}`) : c.red("verifyReceipt false")) : c.red("none")],
      ...r.txs.map((t): [string, string] => ["settlement tx", t]),
      ["buyer log", c.dim(r.buyer.log)],
    ]),
  );
  if (chainId !== 31337) out.push(c.dim(`  every transaction above is on chain ${chainId}; open the links to check them`));
  return out.join("\n");
}
