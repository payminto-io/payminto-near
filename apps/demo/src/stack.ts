import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { formatAmount, networkFor, type Policy } from "@payminto/protocol";
import { AgentClient, NodeHttp, OwnerClient } from "@payminto/sdk";
import { assertDisposableTarget, createLogger, loadConfig, startNode, type ClearingNode } from "@payminto/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentWallet, createMcpServer } from "@payminto/mcp";
import { DEMO_DIR, REPO_ROOT, type DemoConfig, type GatewayKeys } from "./config.ts";
import { forgeDeployLocal, mintLocal, portIsFree, freePort, rpcFor, startAnvil, type AnvilProcess, type Rpc } from "./chain.ts";
import { DashboardSession, DEMO_OWNER_EMAIL, generatePassword, writeLogins, type DemoLogin } from "./session.ts";
import { listen, marketDataApp, PriceSource, researchWriterApp, riskScanApp, rogueApp, type Listening, type Registered } from "./providers.ts";

export type Say = (line: string) => void;

export type Mandates = { treasury: Hex; trading: Hex; writer: Hex };

/** The gateway side of the node: the seeded store's payout, the platform fee wallet and the act's wallets. */
export type GatewayStack = {
  keys: GatewayKeys;
  addresses: { [K in keyof GatewayKeys]: Address };
  platformName: string;
  checkoutBaseUrl: string;
};

export type Stack = {
  cfg: DemoConfig;
  rpc: Rpc;
  hub: Address;
  token: Address;
  node: ClearingNode;
  nodeUrl: string;
  /** Node client signed in as the demo platform owner (session cookie and CSRF, like the dashboard). */
  admin: NodeHttp;
  /** The owner's dashboard session; its `fetch` replaces the recovery key for every operator call. */
  session: DashboardSession;
  /** Dashboard logins created by the demo, saved to `file` in the run directory. */
  logins: { file: string; dashboardUrl: string; items: DemoLogin[] };
  runDir: string;
  dbPath: string;
  logFile: string;
  /** Per-agent durable receipt stores (disposable *.demo.db files in the run dir); a second process of an agent shares its file. */
  receiptStores: { treasury: string; trading: string; writer: string };
  services: { market: string; risk: string; writer: string; rogue: string };
  providerIds: { market: string; risk: string; writer: string; deep: string; rogue: string };
  addresses: { owner: Address; treasury: Address; trading: Address; writer: Address; market: Address; risk: Address; rogue: Address; operator: Address };
  mandates: Mandates;
  policies: { treasury: Policy; trading: Policy; writer: Policy };
  caps: { treasury: bigint; trading: bigint; writer: bigint };
  mandateTx: Partial<Record<keyof Mandates, string | null>>;
  /**
   * The agent onboarded without gas: its mandate was opened with openMandateWithPermit from an EIP-2612 permit it
   * signed, so it never approves on chain. `txBefore` is its transaction count before setup.
   */
  gasless: { agent: "writer"; label: string; address: Address; txBefore: number };
  /** Treasury pays through the SDK directly. */
  treasury: AgentClient;
  /** The Research Writer's own buyer. */
  writer: AgentClient;
  /** Trading Agent is an MCP client: every spend goes through the Payminto MCP tools. */
  trading: { wallet: AgentWallet; mcp: Client };
  /**
   * The same agent keys with their client-side policy guard switched off, standing in for a compromised agent runtime.
   * Used only by the attack steps, to show the node denies (and records) what a jailbroken agent signs anyway.
   */
  compromised: { treasury: AgentClient; trading: AgentClient };
  priceSource: PriceSource;
  /** Null on a live network without DEMO_GATEWAY=1 (the act needs its own funded wallets there). */
  gateway: GatewayStack | null;
  /** The AI agents act (DEMO_AI=1): the payout of the business that sells the skill, on the Treasury Agent's allowlist. */
  ai: { skillPayee: Address } | null;
  /** Display names by lowercase address. */
  names: Map<string, string>;
  stop(): Promise<void>;
};

const USDC = 1_000_000n;

/**
 * Boots the whole demo: anvil (local), forge deploy, the Clearing Node in-process on a disposable *.demo.db,
 * the three providers plus the unlisted attacker endpoint, mandates, funding, approvals and the agents.
 */
export async function startStack(cfg: DemoConfig, opts: { say?: Say; runDir?: string } = {}): Promise<Stack> {
  const say = opts.say ?? (() => {});
  const cleanups: Array<() => Promise<void> | void> = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        // keep stopping the rest
      }
    }
  };

  try {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = opts.runDir ?? join(cfg.dataDir ?? join(DEMO_DIR, "data"), `run-${runId}`);
    mkdirSync(runDir, { recursive: true });
    const dbPath = join(runDir, `clearing-${cfg.chainId}.demo.db`);
    // Data safety: the node's reset/seed guard must accept the target, or we do not start.
    assertDisposableTarget(dbPath);
    const logFile = join(runDir, "node.log");

    // ---------------------------------------------------------------- chain
    let rpcUrl = cfg.rpcUrl;
    let anvil: AnvilProcess | null = null;
    if (!cfg.live && !rpcUrl) {
      say("starting anvil on a free port");
      anvil = await startAnvil();
      cleanups.push(() => anvil!.stop());
      rpcUrl = anvil.rpcUrl;
    }
    const rpc = rpcFor(cfg.chainId, rpcUrl!);
    const actual = await rpc.pub.getChainId();
    if (actual !== cfg.chainId) throw new Error(`RPC ${rpcUrl} serves chain ${actual}, but DEMO_CHAIN_ID is ${cfg.chainId}; refusing`);

    let hub: Address;
    let token: Address;
    const deploymentsDir = join(runDir, "deployments");
    if (!cfg.live) {
      say("deploying ClearingHub + MockStablecoin (forge script DeployLocal)");
      ({ hub, token } = await forgeDeployLocal(rpcUrl!, cfg.keys.deployer!, deploymentsDir));
    } else {
      hub = cfg.deployment!.clearingHub;
      token = cfg.deployment!.token ?? networkFor(cfg.chainId).token.address;
    }

    // ---------------------------------------------------------------- node (in-process)
    let nodePort = cfg.nodePort || (await freePort());
    if (!(await portIsFree(nodePort))) {
      const alt = await freePort();
      say(`port ${nodePort} is busy, the node uses ${alt} instead (start the dashboard with NEXT_PUBLIC_NODE_URL=http://localhost:${alt})`);
      nodePort = alt;
    }
    // Payminto Gateway (docs/GATEWAY.md section 14): locally DeployLocal also deployed the DepositFactory and the
    // PaymentRouter into this run's deployments file; on a live network they come from contracts/deployments. The
    // seeded first merchant is the platform's own store.
    let gateway: GatewayStack | null = null;
    if (cfg.gatewayKeys) {
      const keys = cfg.gatewayKeys;
      const addresses = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v).address])) as GatewayStack["addresses"];
      gateway = { keys, addresses, platformName: "Payminto Demo", checkoutBaseUrl: cfg.live ? cfg.checkoutUrl! : `http://localhost:${dashboardPort()}` };
    }
    // The AI act sells its skill from the seeded first business: locally the store, on a live network the business
    // whose payout DEMO_MERCHANT_PAYOUT names (the gateway is turned on for it there).
    const ai = cfg.ai ? { skillPayee: gateway ? gateway.addresses.storePayout : cfg.ai.merchantPayout! } : null;
    // Seals the business's model key in this run's database; a fresh key each run, never the documented dev key.
    const agentSecretsKey = randomBytes(32).toString("base64");
    const envFor = (port: number): Record<string, string> => {
      const env: Record<string, string> = {
        PORT: String(port),
        HOST: "127.0.0.1",
        CHAIN_ID: String(cfg.chainId),
        RPC_URL: rpcUrl!,
        HUB_ADDRESS: hub,
        TOKEN_ADDRESS: token,
        OPERATOR_KEY: cfg.keys.operator,
        ADMIN_TOKEN: cfg.adminToken,
        DB_PATH: dbPath,
        PUBLIC_URL: `http://localhost:${port}`,
        HSP_MODE: "local",
        HSP_COSIGN_TIMEOUT_SEC: String(cfg.cosignTimeoutSec),
        // DEMO_DASHBOARD_PORT lets the dashboard run elsewhere when 3000 is taken.
        CORS_ORIGINS: `http://localhost:${dashboardPort()},http://127.0.0.1:${dashboardPort()}`,
        LOG_LEVEL: "info",
        SETTLE_INTERVAL_SEC: "0",
        FUNDS_REFRESH_SEC: "5",
      };
      // Account links and the CSRF Origin check point at the local dashboard (live chains require https, so they keep the default).
      if (!cfg.live) env.PUBLIC_DASHBOARD_URL = `http://localhost:${dashboardPort()}`;
      if (!cfg.live) env.DEPLOYMENTS_DIR = deploymentsDir;
      if (gateway) {
        Object.assign(env, {
          GATEWAY_PAYOUT_ADDRESS: gateway.addresses.storePayout,
          PLATFORM_NAME: gateway.platformName,
          PLATFORM_FEE_ADDRESS: gateway.addresses.platformFees,
          PUBLIC_CHECKOUT_URL: gateway.checkoutBaseUrl,
          // Public RPCs rate-limit; half a second is for the local chain.
          GATEWAY_WATCH_INTERVAL_MS: cfg.live ? "2000" : "500",
        });
      }
      if (cfg.confirmTag) env.CONFIRM_TAG = cfg.confirmTag;
      if (cfg.ai && ai) {
        // Live networks: the gateway is on only for the AI act's business, with no platform fee.
        if (!gateway) Object.assign(env, { GATEWAY_PAYOUT_ADDRESS: ai.skillPayee, PUBLIC_CHECKOUT_URL: cfg.ai.checkoutUrl! });
        Object.assign(env, { AGENTS_ENABLED: "true", AGENT_SECRETS_KEY: agentSecretsKey, AGENT_POLL_MS: "250" });
        // A model server on this machine (Ollama, LM Studio, the test stand-in) is a private address.
        if (cfg.ai.localModel) env.AGENT_ALLOW_PRIVATE_MODEL_URLS = "true";
      }
      return env;
    };
    const logger = createLogger({ level: "info", base: { service: "clearing-node" }, sink: (l) => appendFileSync(logFile, l + "\n") });
    say(`starting Clearing Node on :${nodePort} (db ${relative(REPO_ROOT, dbPath)})`);
    // A picked port can be taken by another process before the node binds it; then the node picks again (a port the
    // user named is never swapped silently past the check above).
    let node: ClearingNode;
    for (let attempt = 0; ; attempt++) {
      try {
        node = await startNode(loadConfig(envFor(nodePort)), { logger });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || nodePort === cfg.nodePort || attempt >= 4) throw err;
        nodePort = await freePort();
        say(`that port was just taken, the node uses ${nodePort} instead`);
      }
    }
    cleanups.push(() => node.stop());
    const nodeUrl = `http://localhost:${nodePort}`;

    // ---------------------------------------------------------------- first-run setup (docs/PRODUCT.md 4.2)
    // The recovery key (ADMIN_TOKEN) is the setup code; after setup it stops working, and the demo signs in as the
    // platform owner like a person would, so every operator call below goes through a session with CSRF.
    const dashboardUrl = `http://localhost:${dashboardPort()}`;
    const owner0: DemoLogin = { email: DEMO_OWNER_EMAIL, password: generatePassword(), name: "Demo Owner", role: "Platform owner" };
    const setup = await fetch(`${nodeUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: dashboardUrl },
      body: JSON.stringify({ code: cfg.adminToken, platform_name: gatewayPlatformName(cfg), name: owner0.name, email: owner0.email, password: owner0.password }),
    });
    if (setup.status !== 201) throw new Error(`first-run setup failed: HTTP ${setup.status} ${await setup.text()}`);
    const session = new DashboardSession({ nodeUrl, origin: dashboardUrl, email: owner0.email, password: owner0.password });
    await session.login();
    const logins = { file: writeLogins(runDir, dashboardUrl, [owner0]), dashboardUrl, items: [owner0] };
    say(`first-run setup done: platform owner ${owner0.email} (login saved to ${relative(REPO_ROOT, logins.file)})`);
    const admin = new NodeHttp(nodeUrl, { fetch: session.fetch });
    const operator = node.services.chain.operator.address;

    // ---------------------------------------------------------------- accounts
    const acct = (k: Hex) => privateKeyToAccount(k);
    const addresses = {
      owner: acct(cfg.keys.owner).address,
      treasury: acct(cfg.keys.treasury).address,
      trading: acct(cfg.keys.trading).address,
      writer: acct(cfg.keys.writer).address,
      market: cfg.payees.market,
      risk: cfg.payees.risk,
      rogue: cfg.payees.rogue,
      operator,
    };

    // ---------------------------------------------------------------- providers
    // The four provider ports are registered with the node before they listen, so pick a free block now: a second
    // run (pnpm demo next to pnpm demo:stage) moves on instead of failing after setup.
    let base = cfg.providerBasePort;
    if (!(await providerBlockFree(base))) {
      const moved = await freeProviderBlock();
      say(`ports ${base}-${base + 3} are busy, the paid services use ${moved}-${moved + 3} instead`);
      base = moved;
    }
    const ports = { market: base, risk: base + 1, writer: base + 2, rogue: base + 3 };
    const url = (p: number) => `http://127.0.0.1:${p}`;
    const services = { market: url(ports.market), risk: url(ports.risk), writer: url(ports.writer), rogue: url(ports.rogue) };
    const register = async (name: string, description: string, payee: Address, price: bigint, resource: string, category: string): Promise<Registered> =>
      admin.post(
        "/v1/providers",
        z.object({ id: z.string(), apiKey: z.string() }).loose(),
        { name, description, payee, priceAtomic: price.toString(), resource, category },
      );
    const P = cfg.prices;
    const regMarket = await register("Market Data", `HSK, BTC and ETH spot quotes (live public source with deterministic fallback). ${formatAmount(P.market)} USDC per quote.`, addresses.market, P.market, `${services.market}/v1/quote`, "market-data");
    const regRisk = await register("Risk Scan", `Wallet risk score from a deterministic heuristic (labelled as such, demo only). ${formatAmount(P.risk)} USDC per address.`, addresses.risk, P.risk, `${services.risk}/v1/scan`, "risk");
    const regWriter = await register("Research Writer", `An agent that buys Market Data and Risk Scan to write a brief. ${formatAmount(P.writer)} USDC per brief.`, addresses.writer, P.writer, `${services.writer}/v1/brief`, "research");
    const regDeep = await register("Research Writer Deep Dive", `Long-form report. ${formatAmount(P.deep)} USDC per report.`, addresses.writer, P.deep, `${services.writer}/v1/deep-dive`, "research");
    const regRogue = await register("Premium Alpha (unlisted)", "Unverified service promoted inside a community post.", addresses.rogue, P.rogue, `${services.rogue}/v1/alpha`, "unverified");

    // ---------------------------------------------------------------- mandates
    const owner = new OwnerClient({ nodeUrl, chainId: cfg.chainId, hub, account: acct(cfg.keys.owner), publicClient: rpc.pub, fetch: session.fetch });
    const s = cfg.spend;
    // Local caps follow DEMO_SCRIPT (total cap well above the run); live caps are the planned spend plus 20 %.
    const caps = cfg.live
      ? { treasury: (s.treasury * 12n) / 10n, trading: (s.trading * 12n) / 10n, writer: (s.writer * 12n) / 10n + P.risk }
      : { treasury: 25n * USDC, trading: 10n * USDC, writer: 5n * USDC };
    const policies: Stack["policies"] = {
      treasury: { perCallCap: P.writer.toString(), dailyCap: ((caps.treasury * 8n) / 10n).toString(), maxCallsPerMinute: 3_000, purpose: "Treasury Agent: market data, risk scans and research briefs" },
      trading: { perCallCap: P.risk.toString(), dailyCap: ((caps.trading * 8n) / 10n).toString(), maxCallsPerMinute: 3_000, purpose: "Trading Agent: quotes and counterparty scans only" },
      writer: { perCallCap: P.risk.toString(), dailyCap: caps.writer.toString(), maxCallsPerMinute: 3_000, purpose: "Research Writer buys its inputs" },
    };
    const payees = {
      // The AI buyer agent spends from the Treasury Agent's mandate, so the skill's seller is on its allowlist.
      treasury: [addresses.market, addresses.risk, addresses.writer, ...(ai ? [ai.skillPayee] : [])],
      trading: [addresses.market, addresses.risk],
      writer: [addresses.market, addresses.risk],
    };
    const mandates = {} as Mandates;
    const mandateTx: Stack["mandateTx"] = {};
    const labels = { treasury: "Treasury Agent", trading: "Trading Agent", writer: "Research Writer" } as const;
    const gasless: Stack["gasless"] = {
      agent: "writer",
      label: labels.writer,
      address: addresses.writer,
      txBefore: await rpc.pub.getTransactionCount({ address: addresses.writer }),
    };
    for (const who of ["treasury", "trading", "writer"] as const) {
      const agent = addresses[who];
      const m = await owner.createMandate({ agent, token, totalCap: caps[who], validForSeconds: 12 * 3600, payees: payees[who], policy: policies[who] });
      // Gasless onboarding for the Research Writer: it signs an EIP-2612 permit (read-only calls, no gas) and the node
      // opens its mandate with openMandateWithPermit, which also sets the allowance. The others approve on chain.
      let permit: { value: bigint; deadline: bigint; signature: Hex } | undefined;
      if (who === gasless.agent) {
        const signer = new AgentClient({ chainId: cfg.chainId, hub, nodeUrl, account: acct(cfg.keys[who]), mandateId: m.mandateId });
        permit = await signer.signPermit({ token, value: caps[who], publicClient: rpc.pub });
        signer.close();
      }
      const res = (await owner.submit({ ...m, policy: policies[who], payees: payees[who], label: labels[who], permit })) as {
        status: string;
        openTxHash?: string | null;
      };
      if (res.status !== "open") throw new Error(`${labels[who]} mandate is ${res.status}, expected open`);
      mandates[who] = m.mandateId;
      mandateTx[who] = res.openTxHash ?? null;
    }
    say(`mandates open on chain: Treasury ${short(mandates.treasury)}, Trading ${short(mandates.trading)}, Writer ${short(mandates.writer)}`);

    // ---------------------------------------------------------------- funding and approvals
    for (const who of ["treasury", "trading", "writer"] as const) {
      const a = addresses[who];
      if (!cfg.live) {
        await mintLocal(rpc, cfg.keys.deployer!, token, a, 100n * USDC);
        // gas for approve: anvil accounts 1..8 are pre-funded with ETH already
      } else {
        const bal = await rpc.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] });
        if (bal < caps[who]) throw new Error(`${labels[who]} ${a} holds ${formatAmount(bal)} but needs ${formatAmount(caps[who])}; fund it first`);
      }
    }
    if (!cfg.live) say("minted 100 test USDC to each agent");

    // Each agent keeps its receipts and signed positions in a durable store; the "compromised" runtime of the same
    // key shares it, as any second process of one agent must, or it would refuse to extend positions it cannot verify.
    const receiptStores = {
      treasury: join(runDir, "agent-treasury.receipts.demo.db"),
      trading: join(runDir, "agent-trading.receipts.demo.db"),
      writer: join(runDir, "agent-writer.receipts.demo.db"),
    };
    for (const path of Object.values(receiptStores)) assertDisposableTarget(path);
    const common = { chainId: cfg.chainId, hub, nodeUrl, trustedNode: operator, autoCosign: true, cosignIntervalMs: 250 };
    const treasury = new AgentClient({ ...common, account: acct(cfg.keys.treasury), mandateId: mandates.treasury, storePath: receiptStores.treasury });
    const writer = new AgentClient({ ...common, account: acct(cfg.keys.writer), mandateId: mandates.writer, storePath: receiptStores.writer });
    const tradingWallet = await AgentWallet.connect({
      nodeUrl,
      chainId: cfg.chainId,
      hub,
      agentKey: cfg.keys.trading,
      mandateId: mandates.trading,
      rpcUrl,
      trustedNode: operator,
      receiptStorePath: receiptStores.trading,
    });
    const compromised = {
      treasury: new AgentClient({ chainId: cfg.chainId, hub, nodeUrl, account: acct(cfg.keys.treasury), mandateId: mandates.treasury, enforcePolicy: false, receipts: treasury.receipts }),
      trading: new AgentClient({ chainId: cfg.chainId, hub, nodeUrl, account: acct(cfg.keys.trading), mandateId: mandates.trading, enforcePolicy: false, receipts: tradingWallet.agent.receipts }),
    };
    cleanups.push(() => {
      treasury.close();
      writer.close();
      tradingWallet.close();
    });
    // Approve exactly the mandate cap, never unlimited: the allowance is the agent's on-chain spending ceiling.
    await treasury.ensureAllowance(rpc.wallet(cfg.keys.treasury), caps.treasury, { token, publicClient: rpc.pub });
    // The writer's allowance was set by its permit inside openMandateWithPermit: no approve transaction.
    // Public RPCs are load-balanced: wait for the opening transaction, then give a lagging backend a few reads.
    if (mandateTx.writer) await rpc.pub.waitForTransactionReceipt({ hash: mandateTx.writer as Hex });
    let writerAllowance = 0n;
    for (let i = 0; i < (cfg.live ? 15 : 1); i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2_000));
      writerAllowance = await rpc.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [addresses.writer, hub] });
      if (writerAllowance >= caps.writer) break;
    }
    if (writerAllowance < caps.writer) throw new Error(`Research Writer permit did not set the allowance (${writerAllowance})`);
    say(`Research Writer onboarded gasless: EIP-2612 permit submitted by the node with openMandateWithPermit, agent sent 0 transactions`);
    await tradingWallet.agent.ensureAllowance(rpc.wallet(cfg.keys.trading), caps.trading, { token, publicClient: rpc.pub });
    // A public RPC can serve the node a block from before the approvals for a few seconds after they are mined, and
    // the node would then deny the first calls for want of allowance. Start traffic only once three reads in a row
    // agree that every allowance is in place.
    if (cfg.live) {
      for (const who of ["treasury", "trading", "writer"] as const) {
        let streak = 0;
        for (let i = 0; streak < 3; i++) {
          if (i >= 30) throw new Error(`${labels[who]} allowance is not visible on ${rpcUrl} after 60 s`);
          const v = await rpc.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [addresses[who], hub] });
          streak = v >= caps[who] ? streak + 1 : 0;
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      say("every agent's hub allowance is visible on the RPC (three reads in a row)");
    }

    const mcp = new Client({ name: "trading-agent", version: "0.1.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpServer = createMcpServer(tradingWallet);
    await mcpServer.connect(serverT);
    await mcp.connect(clientT);
    cleanups.push(async () => {
      await mcp.close();
      await mcpServer.close();
    });

    // ---------------------------------------------------------------- serve providers
    const prices = new PriceSource(cfg.offline);
    const servers: Listening[] = [];
    servers.push(await listen(marketDataApp({ node: nodeUrl, reg: regMarket, price: P.market, prices, rogueUrl: `${services.rogue}/v1/alpha`, rogue: addresses.rogue }), ports.market));
    servers.push(await listen(riskScanApp({ node: nodeUrl, reg: regRisk, price: P.risk }), ports.risk));
    servers.push(
      await listen(
        researchWriterApp({ node: nodeUrl, reg: regWriter, deep: regDeep, price: P.writer, deepPrice: P.deep, writer, marketUrl: services.market, riskUrl: services.risk, quotesPerBrief: cfg.plan.briefQuotes }),
        ports.writer,
      ),
    );
    servers.push(await listen(rogueApp({ node: nodeUrl, reg: regRogue, price: P.rogue }), ports.rogue));
    cleanups.push(async () => {
      await Promise.all(servers.map((x) => x.close()));
    });
    say(`providers up: Market Data :${ports.market}, Risk Scan :${ports.risk}, Research Writer :${ports.writer} (attacker endpoint :${ports.rogue})`);

    // Node stops before anvil (cleanups run in reverse order).
    return {
      cfg,
      rpc,
      hub,
      token,
      node,
      nodeUrl,
      admin,
      session,
      logins,
      runDir,
      dbPath,
      logFile,
      receiptStores,
      services,
      providerIds: { market: regMarket.id, risk: regRisk.id, writer: regWriter.id, deep: regDeep.id, rogue: regRogue.id },
      addresses,
      mandates,
      policies,
      caps,
      mandateTx,
      gasless,
      treasury,
      writer,
      trading: { wallet: tradingWallet, mcp },
      compromised,
      priceSource: prices,
      gateway,
      ai,
      names: new Map([
        [addresses.treasury.toLowerCase(), "Treasury Agent"],
        [addresses.trading.toLowerCase(), "Trading Agent"],
        [addresses.writer.toLowerCase(), "Research Writer"],
        [addresses.market.toLowerCase(), "Market Data"],
        [addresses.risk.toLowerCase(), "Risk Scan"],
        [addresses.rogue.toLowerCase(), "Unlisted wallet"],
        ...(ai && !gateway ? ([[ai.skillPayee.toLowerCase(), "Market brief seller"]] as const) : []),
        ...(gateway
          ? ([
              [gateway.addresses.storePayout.toLowerCase(), "Demo Store"],
              [gateway.addresses.platformFees.toLowerCase(), "Platform fees"],
              [gateway.addresses.merchantPayout.toLowerCase(), "Northwind Data"],
              [gateway.addresses.mandateAgent.toLowerCase(), "Procurement Agent"],
            ] as const)
          : []),
      ]),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function providerBlockFree(base: number): Promise<boolean> {
  return (await Promise.all([0, 1, 2, 3].map((i) => portIsFree(base + i)))).every(Boolean);
}

/** A free block of four ports outside the OS ephemeral range, so another process's outgoing sockets cannot take them. */
async function freeProviderBlock(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const base = 20_000 + Math.floor(Math.random() * 20_000);
    if (await providerBlockFree(base)) return base;
  }
  throw new Error("no free block of four ports for the paid services; set DEMO_PROVIDER_BASE_PORT");
}

/** The platform name the demo sets up (the gateway's store name locally, a plain name on live networks). */
function gatewayPlatformName(cfg: DemoConfig): string {
  return !cfg.live && cfg.gatewayKeys ? "Payminto Demo" : "Payminto";
}

export const short = (h: string) => `${h.slice(0, 6)}..${h.slice(-4)}`;

export function dashboardPort(): number {
  return Number(process.env.DEMO_DASHBOARD_PORT ?? 3000);
}
