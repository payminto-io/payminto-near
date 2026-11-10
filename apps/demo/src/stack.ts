import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { keypairFromSeed, type AccountId, type Chain, type Id32, type Keypair, type Policy } from "@payminto/protocol";
import { AgentClient, FileVoucherStore, OwnerClient, paywall, SqliteReceiptStore, type Paywall } from "@payminto/sdk";
import { assertDisposableTarget, loadConfig, silentLogger, startNode, type ClearingNode } from "@payminto/node";
import { AgentWallet, createMcpServer, rpcPayeeCheck, type PayeeCheckFactory } from "@payminto/mcp";
import { MemoryCodeStore, payeeCheckForNode } from "@payminto/payee-check";
import { createHub, type DemoHub } from "./chain.ts";
import { DEMO_DIR, type DemoConfig } from "./config.ts";
import { FAKE_NAMES, OWNER_KEYS, type DemoNames, type Owner } from "./names.ts";
import { freePort } from "./ports.ts";
import { alphaApp, briefsApp, feedApp, listen, mirrorApp, quotesApp, scansApp, type Listening, type Registered } from "./providers.ts";

export type { Owner } from "./names.ts";

export const USDC = 1_000_000n;
export const PRICES = { quote: 2_000n, scan: 5_000n, brief: 50_000n, alpha: 2_000n, feed: 2_000n } as const;

/** The simulated hub's owners and sellers. A run's own accounts are `Stack.names`. */
export const OWNERS = FAKE_NAMES.owners;
export const SELLERS = FAKE_NAMES.sellers;

/** Initech's escrow is small on purpose: its unsettled spending hits the exposure limit. */
export const INITECH_ESCROW = 100_000n;
/** The DAO's agents form a swarm that shares one Budget, so they share its limits. */
export const SWARM_SIZE = 3;

export type Stack = {
  cfg: DemoConfig;
  hub: DemoHub;
  /** Every account in this run. */
  names: DemoNames;
  node: ClearingNode;
  /** The node's own chain client: the operator that settles and pays out. */
  operatorChain: Chain;
  nodeUrl: string;
  /** The node's admin credential, for operator routes such as registering another provider. */
  adminToken: string;
  runDir: string;
  urls: { quotes: string; briefs: string; scans: string; alpha: string; mirror: string; feed: string };
  paywalls: { quotes: Paywall; briefs: Paywall; scans: Paywall; alpha: Paywall; mirror: Paywall; feed: Paywall };
  /** What the node's payee check said about each payee of a Budget when the Budget was registered, read from the node's answer. */
  payeeVerdicts: Record<Owner, Array<{ payee: AccountId; status: string; signals: string[] }>>;
  /** The file the scan seller keeps its latest vouchers in, for settle_own. */
  scanVoucherPath: string;
  keys: Record<Owner, Keypair>;
  budgets: Record<Owner, Id32>;
  policies: Record<Owner, Policy>;
  /** The DAO swarm's hourly cap, in atomic units. */
  swarmHourlyCap: bigint;
  acme: AgentClient;
  /** Acme's key with the client-side guard off: what a compromised agent runtime would do. Only the node stops it. */
  acmeCompromised: AgentClient;
  initech: AgentClient;
  /** Globex's agent pays only through the Payminto MCP tools. */
  globex: { wallet: AgentWallet; mcp: Client };
  swarm: AgentClient[];
  /** Stops the clearing node only (the settle_own act). Idempotent. */
  stopNode(): Promise<void>;
  stop(): Promise<void>;
};

export type StackOptions = {
  runDir?: string;
  /** Progress lines while the chain is set up (the sandbox prints every transaction). */
  say?: (line: string) => void;
};

/**
 * Boots the whole story in-process: the chain from `cfg.chain`, the clearing node on a disposable *.demo.db, four
 * paid services behind the SDK paywall, four Budgets opened and funded from the owners' wallets, and the agents.
 */
export async function startStack(cfg: DemoConfig, opts: StackOptions = {}): Promise<Stack> {
  const cleanups: Array<() => Promise<void> | void> = [];
  const stop = async () => {
    for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => {});
  };
  const say = opts.say ?? (() => {});
  try {
    const runDir = opts.runDir ?? join(cfg.dataDir ?? join(DEMO_DIR, "data"), `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
    mkdirSync(runDir, { recursive: true });
    const disposable = (name: string) => {
      const path = join(runDir, name);
      // Data safety: the node's reset guard must accept every database this demo opens.
      assertDisposableTarget(path);
      return path;
    };

    // The node's signing key exists before the hub, because the hub's deploy sets it as the checkout key.
    const nodeSigningSeed = randomBytes(32).toString("hex");
    const hub = await createHub(cfg.chain, { runDir, checkoutKey: keypairFromSeed(Buffer.from(nodeSigningSeed, "hex")).publicKey, say });
    cleanups.push(() => hub.close());
    const names = hub.names;

    const port = await freePort();
    const adminToken = randomBytes(24).toString("hex");
    const config = loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      NETWORK: hub.chain.network,
      HUB_ACCOUNT: names.hub,
      TOKEN_ACCOUNT: names.token,
      OPERATOR_ACCOUNT: names.operator,
      NODE_SIGNING_SEED: nodeSigningSeed,
      ADMIN_TOKEN: adminToken,
      DB_PATH: disposable("clearing.demo.db"),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      SETTLE_INTERVAL_SEC: "0",
      LOG_LEVEL: "error",
      ...hub.nodeEnv,
    });
    // The payee check is on for both chains: the node reads accounts through the hub's reader. An injected chain alone
    // would leave it off, and a node that reads NEAR itself would build this same reader from RPC_URL.
    const node = await startNode(config, { chain: hub.nodeChain, logger: silentLogger, workers: false, port, payeeCheck: { reader: hub.payeeReader, ageSource: null } });
    let nodeStopped = false;
    const stopNode = async () => {
      if (nodeStopped) return;
      nodeStopped = true;
      await node.stop();
    };
    cleanups.push(stopNode);
    const nodeUrl = node.url;

    // Sellers register their services at the node (an operator route) and put the SDK paywall in front of them.
    const register = async (name: string, payee: AccountId, price: bigint, resource: string): Promise<Registered> => {
      const res = await fetch(`${nodeUrl}/v1/providers`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name, description: `${name} (demo)`, payee, priceAtomic: price.toString(), resource, category: "demo" }),
      });
      if (res.status !== 201) throw new Error(`registering ${name}: HTTP ${res.status} ${await res.text()}`);
      return (await res.json()) as Registered;
    };
    const ports = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort(), freePort()]);
    const at = (i: number) => `http://127.0.0.1:${ports[i]}`;
    const urls = { quotes: at(0), briefs: at(1), scans: at(2), alpha: at(3), mirror: at(4), feed: at(5) };
    const scanVoucherPath = join(runDir, "scan.vouchers.json");
    const scanVouchers = new FileVoucherStore(scanVoucherPath);
    cleanups.push(() => scanVouchers.close());
    const pw = (r: Registered, price: bigint, extra: Partial<Parameters<typeof paywall>[0]> = {}) => paywall({ nodeUrl, providerId: r.id, apiKey: r.apiKey, price, ...extra });
    const { sellers } = names;
    const paywalls = {
      quotes: pw(await register("Globex Quotes", sellers.quotes, PRICES.quote, `${urls.quotes}/v1/quote`), PRICES.quote, { description: "NEAR, BTC and ETH spot quotes" }),
      briefs: pw(await register("Acme Research Briefs", sellers.briefs, PRICES.brief, `${urls.briefs}/v1/brief`), PRICES.brief, { description: "A research brief" }),
      scans: pw(await register("Risk Scan", sellers.scans, PRICES.scan, `${urls.scans}/v1/scan`), PRICES.scan, { description: "Wallet risk score", vouchers: scanVouchers }),
      alpha: pw(await register("Premium Alpha (unlisted)", sellers.alpha, PRICES.alpha, `${urls.alpha}/v1/alpha`), PRICES.alpha, { description: "Premium alpha" }),
      // A seller can register any payee account: the node does not vouch for it. The payee check judges it at payment time.
      mirror: pw(await register("Risk Scan (new address)", sellers.mirror, PRICES.scan, `${urls.mirror}/v1/scan`), PRICES.scan, { description: "Wallet risk score" }),
      feed: pw(await register("New Desk Feed", sellers.fresh, PRICES.feed, `${urls.feed}/v1/feed`), PRICES.feed, { description: "Desk notes from a new vendor" }),
    };
    const servers: Listening[] = [
      await listen(quotesApp({ pay: paywalls.quotes }), ports[0]),
      await listen(briefsApp({ pay: paywalls.briefs, price: PRICES.brief, rogueUrl: `${urls.alpha}/v1/alpha`, rogue: sellers.alpha, mirrorUrl: `${urls.mirror}/v1/scan`, mirror: sellers.mirror, mirrored: sellers.scans }), ports[1]),
      await listen(scansApp({ pay: paywalls.scans }), ports[2]),
      await listen(alphaApp({ pay: paywalls.alpha }), ports[3]),
      await listen(mirrorApp({ pay: paywalls.mirror }), ports[4]),
      await listen(feedApp({ pay: paywalls.feed }), ports[5]),
    ];
    cleanups.push(() => Promise.all(servers.map((l) => l.close())).then(() => undefined));

    // Owners fund their wallets, open one Budget each from their own wallet, and register it with the node.
    const seeds = Object.fromEntries(OWNER_KEYS.map((o) => [o, new Uint8Array(randomBytes(32))])) as Record<Owner, Uint8Array>;
    const keys = Object.fromEntries(OWNER_KEYS.map((o) => [o, keypairFromSeed(seeds[o])])) as Record<Owner, Keypair>;
    const swarmHourlyCap = BigInt(Math.max(4, Math.round(25 * cfg.scale))) * PRICES.quote;
    const policies: Record<Owner, Policy> = {
      acme: { perCallCap: PRICES.scan.toString(), dailyCap: (5n * USDC).toString(), maxCallsPerMinute: 0, purpose: "Acme research agent: buys quotes and scans" },
      globex: { perCallCap: PRICES.brief.toString(), dailyCap: (5n * USDC).toString(), maxCallsPerMinute: 0, purpose: "Globex trading agent: buys briefs and scans" },
      initech: { perCallCap: PRICES.scan.toString(), dailyCap: (5n * USDC).toString(), maxCallsPerMinute: 0, maxRepeatsPerRequest: 3, purpose: "Initech ops agent: wallet screening" },
      dao: { perCallCap: PRICES.quote.toString(), dailyCap: (5n * USDC).toString(), hourlyCap: swarmHourlyCap.toString(), maxCallsPerMinute: 0, purpose: "Guild DAO market-watch swarm" },
    };
    const payees: Record<Owner, AccountId[]> = {
      acme: [sellers.quotes, sellers.scans],
      // Globex also lists a new vendor. Its account has not registered with the token, so the payee check warns about it.
      globex: [sellers.briefs, sellers.scans, sellers.fresh],
      initech: [sellers.scans],
      dao: [sellers.quotes],
    };
    const escrow: Record<Owner, bigint> = { acme: 2n * USDC, globex: 2n * USDC, initech: INITECH_ESCROW, dao: 2n * USDC };
    const budgets = {} as Record<Owner, Id32>;
    const payeeVerdicts = {} as Stack["payeeVerdicts"];
    if (hub.kind === "sandbox") say("   Owners open Budgets from their own wallets, through @payminto/chain's wallet action builders:");
    // Wallets first, so every account the payee check looks at is already what it will be when a Budget is registered.
    // The pure seller and the unlisted seller register with the token so payouts could reach them; the new vendor does not.
    await Promise.all([...OWNER_KEYS.map((who) => hub.wallets.fund(names.owners[who], 10n * USDC)), hub.wallets.register(sellers.scans), hub.wallets.register(sellers.alpha)]);
    // Each owner signs only its own transactions, so the four owners go in parallel.
    await Promise.all(
      OWNER_KEYS.map(async (who) => {
        const account = names.owners[who];
        const owner = new OwnerClient({ nodeUrl, network: hub.chain.network, hub: names.hub, token: names.token, owner: account, settler: names.operator, adminToken });
        const b = owner.createBudget({ agentPk: keys[who].publicKey, cap: 5n * USDC, validForSeconds: 12 * 3600, payees: payees[who], policy: policies[who] });
        budgets[who] = await hub.wallets.openBudget(account, b.terms, escrow[who]);
        if (budgets[who] !== b.budgetId) throw new Error(`the hub opened ${budgets[who]}, not ${b.budgetId}`);
        // The node looks at every payee on the list when a Budget is registered, and its answer carries the verdicts.
        const created = (await owner.submit({ terms: b.terms, policy: policies[who], label: `${who} agent` })) as { payeeChecks?: Array<{ payee: AccountId; status: string; verdict: { signals: Array<{ id: string; severity: string }> } }> | null };
        payeeVerdicts[who] = (created.payeeChecks ?? []).map((c) => ({ payee: c.payee, status: c.status, signals: c.verdict.signals.filter((x) => x.severity !== "info").map((x) => x.id) }));
      }),
    );

    const nodeKey = node.services.chain.nodeKey;
    const common = { network: hub.chain.network, hub: names.hub, nodeUrl, trustedNodeKey: nodeKey };
    const acmeStore = new SqliteReceiptStore(disposable("acme.receipts.demo.db"));
    const swarmStore = new SqliteReceiptStore(disposable("dao-swarm.receipts.demo.db"));
    cleanups.push(() => {
      acmeStore.close();
      swarmStore.close();
    });
    const acme = new AgentClient({ ...common, keypair: keys.acme, budgetId: budgets.acme, receipts: acmeStore });
    const acmeCompromised = new AgentClient({ ...common, keypair: keys.acme, budgetId: budgets.acme, receipts: acmeStore, enforcePolicy: false });
    const initech = new AgentClient({ ...common, keypair: keys.initech, budgetId: budgets.initech, storePath: disposable("initech.receipts.demo.db") });
    cleanups.push(() => initech.close());
    // A swarm: several agents with the one Budget key, sharing one receipt store, as the SDK requires. Calls go in turns,
    // so a re-sign after another worker moved the position needs no backoff.
    const swarm = Array.from({ length: SWARM_SIZE }, () => new AgentClient({ ...common, keypair: keys.dao, budgetId: budgets.dao, receipts: swarmStore, sleep: async () => {} }));

    // The wallet checks every payee before it signs. On sandbox that is the MCP server's own wiring: read-only RPC on
    // the sandbox, no indexer. On the simulated hub it is the same check over the hub's fake reader.
    const walletCheck: PayeeCheckFactory = hub.rpcUrl
      ? rpcPayeeCheck({ rpcUrl: hub.rpcUrl, indexer: "off", codeStorePath: join(runDir, "globex.payee-code.json") })
      : ({ token, history }) => {
          const check = payeeCheckForNode({ reader: hub.payeeReader, token, history, codeStore: new MemoryCodeStore() });
          return (r) => check(r.payer ?? null, r.payee, 0n, r.budgetPayees ?? null);
        };
    // The MCP wallet proves receipts through the read side, which on sandbox holds no key.
    const wallet = await AgentWallet.connect({ nodeUrl, agentKey: seeds.globex, budgetId: budgets.globex, chain: hub.chain, trustedNodeKey: nodeKey, receiptStorePath: disposable("globex.receipts.demo.db"), payeeCheck: walletCheck });
    cleanups.push(() => wallet.close());
    const mcp = new Client({ name: "globex-agent", version: "0.1.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpServer = createMcpServer(wallet);
    await mcpServer.connect(serverT);
    await mcp.connect(clientT);
    cleanups.push(async () => {
      await mcp.close();
      await mcpServer.close();
    });

    return {
      cfg,
      hub,
      names,
      node,
      operatorChain: node.services.chain.chain,
      nodeUrl,
      adminToken,
      runDir,
      urls,
      paywalls,
      scanVoucherPath,
      keys,
      budgets,
      policies,
      payeeVerdicts,
      swarmHourlyCap,
      acme,
      acmeCompromised,
      initech,
      globex: { wallet, mcp },
      swarm,
      stopNode,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
