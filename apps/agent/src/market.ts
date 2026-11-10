/**
 * `payminto-agent market work`: the brief-writing agent takes jobs from the NEAR AI Agent Market.
 *
 * The limits are the package's, and they are hard. Payminto does not settle, hold or route Agent Market jobs: a market
 * hire is paid through the market, on NEAR mainnet. What this adds is on the agent's own side of a job. It buys its
 * inputs through its Payminto Budget as it always does, under a spend ceiling per job that only the worker's owner
 * sets, and the deliverable ends with a "Verifiable costs" section that lists the receipts of those purchases.
 *
 * Job text is untrusted. It reaches the writing model fenced and labelled as data. It never chooses a payee, a price or
 * the ceiling: the suppliers come from the worker's configuration or the node's directory, and the ceiling from the
 * command line.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { HUMAN_SETUP_STEPS, MarketError, createMarketWorker, jobAsData, toInputReceipts, type DryRunResult, type Fulfil, type InputReceipt, type MarketJob, type WorkerEvent } from "@payminto/agent-market";
import type { ModelClient } from "@payminto/models";
import { formatAmount, isAccountId, isPublicKey, keypairFromSeed, toAtomic, type AccountId, type Keypair, type PublicKey } from "@payminto/protocol";
import { AgentClient, AgentKeyFileError, defaultAgentKeyPath, NodeHttp, readAgentKeyFile } from "@payminto/sdk";
import { attestationLabel, researchBrief, type BriefInputs } from "./brief.ts";
import { AgentConfigError, MissingApiKeyError, modelFromEnv } from "./config.ts";
import { discoverInputs, SYMBOLS } from "./seller.ts";

type Env = Record<string, string | undefined>;

/** Exit code when a person has to set something up first (no token): the same code as the package's own command. */
export const EXIT_NEEDS_PERSON = 4;
/** The most one job may spend on inputs when `--ceiling` is not given: 0.10 USDC. */
export const DEFAULT_CEILING_ATOMIC = "100000";
const USDC = { symbol: "USDC", decimals: 6 };

// A NEAR account id ending in a top-level name, as it appears in running text.
const ACCOUNT_IN_TEXT = /(?:[a-z0-9]+[-_.])*[a-z0-9]+\.(?:testnet|near)\b/g;

/**
 * What the brief is about, read from the job as data: which of the three symbols it names, and the first account it
 * names for the risk read. Looking an account up is not paying it. Nothing here chooses a payee, a price or a limit.
 */
export function briefRequestOf(job: Pick<MarketJob, "title" | "description">): { symbols: string[]; address: string | null } {
  const text = `${job.title}\n${job.description}`;
  // An account name such as collector.near is not a mention of NEAR.
  const words = text.replace(ACCOUNT_IN_TEXT, " ");
  const named = SYMBOLS.filter((s) => new RegExp(`\\b${s}\\b`, "i").test(words));
  const address = (text.match(ACCOUNT_IN_TEXT) ?? []).find((a) => isAccountId(a)) ?? null;
  return { symbols: named.length ? [...named] : ["NEAR", "ETH"], address };
}

/** Where a purchase settled and where its receipt file is, per call id. */
export type Proofs = { batchOf: (callId: string) => string | null; fileOf: (callId: string) => string | undefined };

export type MarketBriefDeps = {
  /** The agent's own buyer, bound to its own Budget. */
  buyer: AgentClient;
  inputs: BriefInputs | (() => Promise<BriefInputs>);
  /** Null writes the template brief from the purchased data. */
  model: ModelClient | null;
  /** The Payminto hub that clears the purchases, and its network. */
  hub: AccountId;
  network: InputReceipt["network"];
  rpcUrl?: string;
  /** Asked after the purchases: which of them are settled, and where their receipt files were written. */
  proofs?: (callIds: string[]) => Promise<Proofs>;
  /** Extra lines for "How this brief was made", for example that a dry run used a simulated hub. */
  notes?: string[];
  onBrief?: (info: { job: MarketJob; instruction: string }) => void;
};

/**
 * The `fulfil` of the market worker: one job in, a Markdown brief and the receipts of what was bought out. Each
 * purchase is asked of the job's spend guard first and signed for no more than what is left of the ceiling.
 */
export function marketBriefFulfil(d: MarketBriefDeps): Fulfil {
  const fmt = (a: bigint) => `${formatAmount(a, USDC.decimals)} ${USDC.symbol}`;
  return async (job, ctx) => {
    const { symbols, address } = briefRequestOf(job);
    const inputs = typeof d.inputs === "function" ? await d.inputs().catch(() => null) : d.inputs;
    // jobAsData fences the buyer's text and labels it as data, not instructions.
    const instruction = `Write the brief this job asks for, as plain text.\n\n${jobAsData(job)}`;
    d.onBrief?.({ job, instruction });
    const r = await researchBrief({
      buyer: d.buyer,
      inputs,
      model: d.model,
      symbols,
      address,
      focus: null,
      instruction,
      fmt,
      spend: {
        // What is left of the ceiling is the most the next voucher may be signed for.
        next: () => {
          const left = BigInt(ctx.spend.remainingAtomic);
          return left > 0n ? left : null;
        },
        took: (amount) => {
          if (amount > 0n) ctx.spend.authorize(amount);
        },
      },
    });
    const proofs = r.purchases.length && d.proofs ? await d.proofs(r.purchases.map((p) => p.callId)).catch(() => null) : null;
    const receipts = toInputReceipts(
      r.purchases.map((p) => ({ callId: p.callId, payee: p.payee, amountAtomic: p.amountAtomic, service: p.service })),
      { hub: d.hub, network: d.network, ...(d.rpcUrl ? { rpcUrl: d.rpcUrl } : {}), ...(proofs ? { batchOf: proofs.batchOf, fileOf: proofs.fileOf } : {}) },
    );
    const spent = r.purchases.reduce((s, p) => s + BigInt(p.amountAtomic), 0n);
    const w = r.writtenBy;
    const made = [
      w.model ? `- Written by the model ${w.model}${w.provider ? ` (provider ${w.provider})` : ""}.` : `- Written from a fixed template, because the writing model was not available (${w.fallback ?? "unknown reason"}).`,
      // The provider's own check of the enclave, repeated as it is: never more than the status says.
      ...(w.attestation ? [`- Enclave attestation of the writing turn: ${attestationLabel(w.attestation.status)}. ${w.attestation.summary}`] : []),
      r.purchases.length ? `- Paid inputs: ${r.purchases.map((p) => p.service).join(", ")} (${r.purchases.length} purchase${r.purchases.length === 1 ? "" : "s"}, ${fmt(spent)}).` : "- Paid inputs: none.",
      ...(r.missing.length ? [`- Not available: ${r.missing.join("; ")}.`] : []),
      ...(d.notes ?? []).map((n) => `- ${n}`),
    ];
    return { deliverableMarkdown: ["# NEAR market brief", "", r.brief.trim(), "", "## How this brief was made", "", ...made].join("\n"), receipts };
  };
}

const proofSchema = z
  .object({
    receipt: z.object({ callId: z.string() }).loose(),
    batchId: z.string().nullable(),
    batchStatus: z.string().nullable().optional(),
    proof: z.array(z.string()),
  })
  .loose();

/**
 * Looks each purchase up on the agent's own node. For one that is in a confirmed batch it writes the receipt file that
 * `pnpm verify:near --receipt <file>` reads, into `dir`, and names it by the relative path the command will print.
 * A purchase that is not settled yet gets no file, and the section then says so.
 */
export function nodeProofs(o: { nodeUrl: string; operator: AccountId; hub: AccountId; network: InputReceipt["network"]; rpcUrl: string | null; dir: string; relative: string; before?: () => Promise<void> }) {
  const node = new NodeHttp(o.nodeUrl);
  return async (callIds: string[]): Promise<Proofs> => {
    // The file format belongs to `pnpm verify:near` (apps/demo/src/verify.ts): it is built and checked with its own schema.
    const { RECEIPT_FILE_KIND, receiptFileSchema } = await import("@payminto/demo");
    await o.before?.();
    const batches = new Map<string, string>();
    const files = new Map<string, string>();
    for (const callId of callIds) {
      const p = await node.get(`/v1/receipts/${callId}/proof`, proofSchema).catch(() => null);
      if (!p || !p.batchId || p.batchStatus !== "confirmed" || p.receipt.callId !== callId) continue;
      // Where the hub is, the batch, the Merkle path and the receipt. A proof the schema does not accept gets no file.
      const file = receiptFileSchema.safeParse({ kind: RECEIPT_FILE_KIND, network: o.network, hub: o.hub, operator: o.operator, rpcUrl: o.rpcUrl, batchId: p.batchId, proof: p.proof, receipt: p.receipt });
      if (!file.success) continue;
      batches.set(callId, p.batchId);
      const name = `${callId.slice(0, 16)}.json`;
      mkdirSync(o.dir, { recursive: true });
      writeFileSync(join(o.dir, name), `${JSON.stringify(file.data, null, 2)}\n`);
      files.set(callId, `${o.relative}/${name}`);
    }
    return { batchOf: (id) => batches.get(id) ?? null, fileOf: (id) => files.get(id) };
  };
}

export type DryRun = DryRunResult & {
  /** Where the receipt files of this run were written. */
  receiptsDir: string;
  /** Each written receipt file, checked in process against the simulated hub of this run. */
  checked: Array<{ file: string; ok: boolean }>;
  ceilingAtomic: string;
  /** The model that wrote, or the reason the template was used. */
  writer: string;
};

/**
 * The whole seller flow with no market account: the package's recorded assignment (or `rows`) runs through the real
 * worker, and the brief agent buys its inputs with real paid calls on an in-process clearing node on the simulated
 * hub. The receipts are the node's own. Nothing reaches the market, a real network or a real account.
 */
export async function marketDryRun(o: { model: ModelClient | null; ceilingAtomic: string; rows?: readonly unknown[]; receiptsDir: string; relative: string; onEvent?: (e: WorkerEvent) => void; modelNote?: string }): Promise<DryRun> {
  // The demo stack is loaded only here: the simulated hub, a clearing node on a *.demo.db in a temp folder, paid
  // suppliers behind the SDK paywall, and Acme's funded Budget for the agent.
  const { loadDemoConfig, receiptFileSchema, startStack, verifyReceipt } = await import("@payminto/demo");
  const dataDir = mkdtempSync(join(tmpdir(), "payminto-market-dry-run-"));
  const stack = await startStack(loadDemoConfig({ DEMO_DATA_DIR: dataDir }, ["--scale", "0.2"]));
  try {
    const info = await new NodeHttp(stack.nodeUrl).get("/v1/info", z.object({ hub: z.string(), operator: z.string(), network: z.object({ id: z.enum(["near:testnet", "near:sandbox"]) }).loose() }).loose());
    const settle = async () => {
      // A dry run settles its own batch at once, so the deliverable can show the proof command a live run shows later.
      await fetch(`${stack.nodeUrl}/v1/settlements`, { method: "POST", headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" }, body: "{}" });
    };
    // Every receipt file this run writes, so each one can be checked below against the hub it was settled on.
    const written: string[] = [];
    const proofs = nodeProofs({ nodeUrl: stack.nodeUrl, operator: info.operator, hub: info.hub, network: info.network.id, rpcUrl: null, dir: o.receiptsDir, relative: o.relative, before: settle });
    const fulfil = marketBriefFulfil({
      buyer: stack.acme,
      inputs: { quoteUrl: `${stack.urls.quotes}/v1/quote`, riskUrl: `${stack.urls.scans}/v1/scan` },
      model: o.model,
      hub: info.hub,
      network: info.network.id,
      proofs: async (callIds) => {
        const p = await proofs(callIds);
        for (const id of callIds) {
          const file = p.fileOf(id);
          if (file && !written.includes(file)) written.push(file);
        }
        return p;
      },
      ...(o.modelNote ? { notes: [o.modelNote] } : {}),
    });
    // The receipts section says itself that its receipts come from a simulated hub, and prints no command for them.
    const result = await createMarketWorker({ fulfil, spendCeilingAtomic: o.ceilingAtomic, receipts: { simulatedHub: true }, ...(o.onEvent ? { onEvent: o.onEvent } : {}) }).dryRun({ ...(o.rows ? { rows: o.rows } : {}), realReceipts: true });
    // Every file this run wrote is checked here against the hub it was settled on, with the verifier of `pnpm verify:near`.
    const checked: DryRun["checked"] = [];
    for (const rel of written) {
      const file = receiptFileSchema.parse(JSON.parse(readFileSync(join(o.receiptsDir, rel.slice(o.relative.length + 1)), "utf8")));
      checked.push({ file: rel, ok: (await verifyReceipt(stack.hub.chain, file)).ok });
    }
    return { ...result, receiptsDir: o.receiptsDir, checked, ceilingAtomic: o.ceilingAtomic, writer: o.model ? `${o.model.provider}/${o.model.model}` : "template (no model key is set)" };
  } finally {
    await stack.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const hex32 = (what: string) => z.string().regex(/^[0-9a-f]{64}$/, `must be a 32-byte ${what} as 64 lowercase hex characters`);
const liveSchema = z.object({
  NODE_URL: z.url("must be the clearing node base URL"),
  SELLER_AGENT_KEY: hex32("ed25519 seed").optional(),
  SELLER_AGENT_KEY_FILE: z.string().min(1).optional(),
  SELLER_BUDGET_ID: hex32("Budget id"),
  SELLER_RECEIPT_STORE_PATH: z.string().min(1).optional(),
  SELLER_QUOTE_URL: z.url().optional(),
  SELLER_RISK_URL: z.url().optional(),
  TRUSTED_NODE_KEY: z.string().refine((v) => isPublicKey(v), "must be an ed25519:<base58> public key").optional(),
  PAYMINTO_DATA_DIR: z.string().min(1).optional(),
});

export type MarketWorkArgs = { dryRun: boolean; ceilingAtomic: string; once: boolean; json: boolean; assignment?: string; receiptsDir: string };

/** Parses `market work` arguments. `--ceiling` is in USDC, as in the package's own command. */
export function parseMarketArgs(argv: string[]): MarketWorkArgs {
  if (argv[0] !== "work") throw new AgentConfigError([`market: unknown subcommand ${argv[0] ?? "(none)"}; the available one is: market work [--dry-run] [--ceiling <usdc>] [--assignment <file.json>] [--receipts-dir <dir>] [--once] [--json]`]);
  const a: MarketWorkArgs = { dryRun: false, ceilingAtomic: DEFAULT_CEILING_ATOMIC, once: false, json: false, receiptsDir: "receipts" };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new AgentConfigError([`${flag}: needs a value`]);
      return v;
    };
    if (flag === "--dry-run") a.dryRun = true;
    else if (flag === "--once") a.once = true;
    else if (flag === "--json") a.json = true;
    else if (flag === "--assignment") a.assignment = value();
    else if (flag === "--receipts-dir") {
      a.receiptsDir = value();
      if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,150}$/.test(a.receiptsDir) || a.receiptsDir.includes("..")) throw new AgentConfigError(["--receipts-dir: a plain relative folder, for example receipts (the proof command prints this path)"]);
    } else if (flag === "--ceiling") {
      const v = value();
      if (!/^\d{1,9}(\.\d{1,6})?$/.test(v)) throw new AgentConfigError(['--ceiling: the most one job may spend on inputs, in USDC, for example "0.10"']);
      a.ceilingAtomic = toAtomic(v, USDC.decimals).toString();
    } else throw new AgentConfigError([`market work: unknown option ${flag}`]);
  }
  return a;
}

/** The model for the brief, from the environment: any configured provider, NEAR AI Cloud (`nearai`) included. Null with a reason when no key is set. */
function writerFromEnv(env: Env): { model: ModelClient | null; note?: string } {
  try {
    return { model: modelFromEnv(env) };
  } catch (err) {
    if (!(err instanceof MissingApiKeyError)) throw err;
    return { model: null, note: `No model key is set (${err.variable}), so the brief below is the fixed template built from the purchased data.` };
  }
}

/**
 * Runs `market work`. A dry run needs nothing. A live run needs the agent's market token, its key and its Budget.
 * Without a token it prints the steps a person takes and returns the package's exit code for that, 4.
 */
export async function marketWork(argv: string[], env: Env, io: { out: (s: string) => void; log: (s: string) => void; signal: AbortSignal; cwd: string }): Promise<number> {
  const args = parseMarketArgs(argv);
  const onEvent = (e: WorkerEvent) => io.log(`market: ${JSON.stringify(e)}`);
  const receiptsDir = resolve(io.cwd, args.receiptsDir);

  if (args.dryRun) {
    const writer = writerFromEnv(env);
    let rows: unknown[] | undefined;
    if (args.assignment) {
      const parsed: unknown = JSON.parse(readFileSync(isAbsolute(args.assignment) ? args.assignment : resolve(io.cwd, args.assignment), "utf8"));
      rows = Array.isArray(parsed) ? parsed : [parsed];
    }
    io.log(`dry run: an in-process clearing node on the simulated hub, the recorded assignment, a ceiling of ${formatAmount(args.ceilingAtomic, USDC.decimals)} USDC per job, no market account`);
    const r = await marketDryRun({ model: writer.model, ceilingAtomic: args.ceilingAtomic, ...(rows ? { rows } : {}), receiptsDir, relative: args.receiptsDir, onEvent, ...(writer.note ? { modelNote: writer.note } : {}) });
    if (args.json) io.out(JSON.stringify(r, null, 2));
    else {
      io.out(`DRY RUN: nothing was sent to the market. What the worker would have sent, in order: ${r.calls.map((c) => `${c.call} ${c.assignmentId}`).join(", ") || "nothing"}.`);
      io.out(`Spend ceiling per job: ${formatAmount(r.ceilingAtomic, USDC.decimals)} USDC, set on the command line. Writer: ${r.writer}.`);
      for (const d of r.deliverables) io.out(`\n----- deliverable for assignment ${d.assignmentId} -----\n${d.markdown}`);
      for (const c of r.checked) io.out(`Checked ${c.file} in process against this run's simulated hub: ${c.ok ? "VERIFIED" : "NOT VERIFIED"}.`);
      if (r.checked.length) io.out(`The receipt files are in ${r.receiptsDir}.`);
    }
    return r.summary.submitted > 0 && r.checked.every((c) => c.ok) ? 0 : 1;
  }

  const token = env.AGENT_MARKET_TOKEN?.trim();
  if (!token) {
    io.out("The market worker needs this agent's token (AGENT_MARKET_TOKEN), and a person has to create it once:");
    for (const step of HUMAN_SETUP_STEPS.slice(0, 4)) io.out(`  ${step}`);
    io.out("  5. Run the worker with that token: AGENT_MARKET_TOKEN=aat_... pnpm agent market work --ceiling <usdc>");
    io.out(`  ${HUMAN_SETUP_STEPS[5]}`);
    io.out("Next: see the whole flow first with no account: pnpm agent market work --dry-run");
    return EXIT_NEEDS_PERSON;
  }

  const p = liveSchema.safeParse(env);
  if (!p.success) throw new AgentConfigError(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const e = p.data;
  const nodeUrl = e.NODE_URL.replace(/\/+$/, "");
  const info = await new NodeHttp(nodeUrl).get("/v1/info", z.object({ hub: z.string(), operator: z.string(), network: z.object({ id: z.enum(["near:testnet", "near:sandbox"]), rpc_url: z.string().optional() }).loose() }).loose());
  let keypair: Keypair;
  try {
    keypair = e.SELLER_AGENT_KEY ? keypairFromSeed(Uint8Array.from(Buffer.from(e.SELLER_AGENT_KEY, "hex"))) : readAgentKeyFile(e.SELLER_AGENT_KEY_FILE ?? defaultAgentKeyPath(env));
  } catch (err) {
    throw new AgentConfigError([`SELLER_AGENT_KEY_FILE: ${err instanceof AgentKeyFileError ? err.message : "cannot read the key file"}`]);
  }
  const writer = writerFromEnv(env);
  if (!writer.model) io.log(`${writer.note} Set the provider's key to have a model write the briefs.`);
  const buyer = new AgentClient({
    network: info.network.id,
    hub: info.hub,
    nodeUrl,
    keypair,
    budgetId: e.SELLER_BUDGET_ID,
    storePath: resolve(e.SELLER_RECEIPT_STORE_PATH ?? join(e.PAYMINTO_DATA_DIR ?? join(homedir(), ".payminto"), "agent", `seller-${info.network.id.replace(":", "-")}-${keypair.publicKey.slice("ed25519:".length)}.db`)),
    trustedNodeKey: e.TRUSTED_NODE_KEY as PublicKey | undefined,
  });
  buyer.on("error", (err) => io.log(`seller wallet: ${err.message}`));
  try {
    const fulfil = marketBriefFulfil({
      buyer,
      inputs: e.SELLER_QUOTE_URL && e.SELLER_RISK_URL ? { quoteUrl: e.SELLER_QUOTE_URL, riskUrl: e.SELLER_RISK_URL } : () => discoverInputs(nodeUrl),
      model: writer.model,
      hub: info.hub,
      network: info.network.id,
      ...(info.network.rpc_url ? { rpcUrl: info.network.rpc_url } : {}),
      proofs: nodeProofs({ nodeUrl, operator: info.operator, hub: info.hub, network: info.network.id, rpcUrl: info.network.rpc_url ?? null, dir: receiptsDir, relative: args.receiptsDir }),
    });
    io.log(`working the Agent Market as ${keypair.publicKey}: at most ${formatAmount(args.ceilingAtomic, USDC.decimals)} USDC of inputs per job from Budget ${e.SELLER_BUDGET_ID}; the market pays the jobs, on NEAR mainnet`);
    try {
      const summary = await createMarketWorker({ fulfil, spendCeilingAtomic: args.ceilingAtomic, token, onEvent }).start(io.signal, { once: args.once }).done;
      io.out(args.json ? JSON.stringify(summary, null, 2) : `Stopped (${summary.stopped}): ${summary.polls} polls, ${summary.taken} jobs taken, ${summary.submitted} submitted, ${summary.declined} declined, ${summary.failed} failed.`);
      return 0;
    } catch (err) {
      if (!(err instanceof MarketError)) throw err;
      io.out(`${err.code}: ${err.message}`);
      io.out(`Next: ${err.nextStep}`);
      return err.code === "TOKEN_REQUIRED" || err.code === "UNAUTHORIZED" ? EXIT_NEEDS_PERSON : 1;
    }
  } finally {
    buyer.close();
  }
}
