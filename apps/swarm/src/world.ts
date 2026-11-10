/**
 * Boots everything a run needs, in one process: the hub (simulated, or a local near-sandbox through the demo's hub
 * factory), the real clearing node on a disposable database, the coordinator service, one sub-account, key and Budget
 * per agent, and the sellers' and data hosts' paywalled servers.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createHub, freePort, listen, type ChainKind, type DemoHub, type Listening } from "@payminto/demo";
import { assertDisposableTarget, loadConfig, silentLogger, startNode, type ClearingNode } from "@payminto/node";
import { keypairFromSeed, type AccountId, type Chain, type Policy, type PublicKey } from "@payminto/protocol";
import { OwnerClient, paywall, type Paywall } from "@payminto/sdk";
import { BuyerAgent, SellerAgent, type BudgetFacts, type ClientOptions } from "./agents.ts";
import { Coordinator, coordinatorApp, ManualClock } from "./coordinator.ts";
import { storageSupplierOf, type RosterEntry } from "./rules.ts";
import { agentsOf, capacityOf, CONSTRAINED_BUDGET, seededSalt, type AgentSpec, type Scenario } from "./scenario.ts";

export class SwarmStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmStartError";
  }
}

export type Registered = { id: string; apiKey: string };

export type World = {
  scenario: Scenario;
  hub: DemoHub;
  /** The read side: what every check reads. On sandbox it holds no key. */
  chain: Chain;
  node: ClearingNode;
  nodeUrl: string;
  nodeKey: PublicKey;
  adminToken: string;
  /** The parent account every agent is a direct sub-account of. */
  parent: AccountId;
  roster: RosterEntry[];
  coordinator: Coordinator;
  coordinatorUrl: string;
  openerToken: string;
  clock: ManualClock;
  buyers: BuyerAgent[];
  sellers: SellerAgent[];
  /** Lists a paid service at the node (an operator route) and returns the paywall for it. */
  listService(o: { name: string; payee: AccountId; price: bigint; resource: string; description: string }): Promise<Paywall>;
  stop(): Promise<void>;
};

export type WorldOptions = {
  chain: ChainKind;
  /** Where round files, receipts and (on sandbox) the sandbox log go. */
  outDir: string;
  say?: (line: string) => void;
};

const USDC = 1_000_000n;

/** What each agent's Budget is, from its role and scripted strategy. Sized so an honest agent never hits a limit. */
export function budgetPlan(s: Scenario, a: AgentSpec): { cap: bigint; escrow: bigint; perCallCap: bigint; dailyCap: bigint; purpose: string } {
  if (a.role === "buyer") {
    const full = BigInt(s.rounds * Math.max(s.demand.max, 6)) * s.reserveUnitPrice;
    const small = CONSTRAINED_BUDGET(s.reserveUnitPrice);
    return {
      cap: a.strategy === "capped" ? small : full,
      escrow: a.strategy === "thin" ? small : full,
      perCallCap: s.reserveUnitPrice,
      // The daily limit is never the tight one here, so a small cap is refused as TOTAL_CAP.
      dailyCap: full,
      purpose: `buyer-${a.index}: GPU hours for its user, at most the reserve price per unit`,
    };
  }
  const maxUnits = BigInt(Math.max(1, ...Array.from({ length: s.rounds }, (_, i) => capacityOf(s, a, i + 1))));
  const perRound = (maxUnits / BigInt(s.storage.every) + 1n) * s.storage.price + (maxUnits / BigInt(s.data.every) + 1n) * s.data.price;
  const cap = BigInt(s.rounds) * perRound + USDC;
  return { cap, escrow: cap, perCallCap: s.storage.price > s.data.price ? s.storage.price : s.data.price, dailyCap: cap, purpose: `seller-${a.index}: checkpoint storage and dataset shards for the units it delivers` };
}

/** A server that listens before its routes exist, so a paywall can be registered with the real URL first. */
async function listenLater(): Promise<{ listening: Listening; serve(app: Hono): void }> {
  let inner: Hono | null = null;
  const outer = new Hono();
  outer.all("*", (c) => (inner ? inner.fetch(c.req.raw) : c.json({ error: { code: "STARTING", message: "this agent is still starting" } }, 503)));
  return { listening: await listen(outer, 0), serve: (app) => void (inner = app) };
}

export async function startWorld(scenario: Scenario, o: WorldOptions): Promise<World> {
  const say = o.say ?? (() => {});
  const cleanups: Array<() => Promise<void> | void> = [];
  const stop = async () => {
    for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => {});
  };
  try {
    mkdirSync(o.outDir, { recursive: true });
    // The node's database lives in the OS temp directory and is deleted with the run.
    let tmp: string;
    try {
      tmp = mkdtempSync(join(tmpdir(), "payminto-swarm-"));
    } catch (err) {
      throw new SwarmStartError(
        `the clearing node did not start: it keeps its database in the temp directory, and ${tmpdir()} cannot be written (${(err as NodeJS.ErrnoException).code ?? String(err)}).\nWhat to do: point TMPDIR at a writable directory and run the command again, for example: TMPDIR=/tmp pnpm swarm`,
      );
    }
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const dbPath = join(tmp, "clearing.demo.db");
    // Data safety: the node's own guard must accept the database before anything opens it.
    assertDisposableTarget(dbPath);

    const nodeSigningSeed = randomBytes(32).toString("hex");
    const hub = await createHub(o.chain, { runDir: o.outDir, checkoutKey: keypairFromSeed(Buffer.from(nodeSigningSeed, "hex")).publicKey, say });
    cleanups.push(() => hub.close());
    const names = hub.names;
    const root = names.hub.slice(names.hub.indexOf(".") + 1);
    // The simulated hub lives at hub.demo.testnet, so the swarm's parent is swarm.testnet; a sandbox names it under its root.
    const parent: AccountId = hub.kind === "fake" ? "swarm.testnet" : `swarm.${root}`;
    const specs = agentsOf(scenario, parent);

    const adminToken = randomBytes(24).toString("hex");
    let node: ClearingNode | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && !node; attempt++) {
      const port = await freePort();
      try {
        const config = loadConfig({
          PORT: String(port),
          HOST: "127.0.0.1",
          NETWORK: hub.chain.network,
          HUB_ACCOUNT: names.hub,
          TOKEN_ACCOUNT: names.token,
          OPERATOR_ACCOUNT: names.operator,
          NODE_SIGNING_SEED: nodeSigningSeed,
          ADMIN_TOKEN: adminToken,
          DB_PATH: dbPath,
          PUBLIC_URL: `http://127.0.0.1:${port}`,
          SETTLE_INTERVAL_SEC: "0",
          LOG_LEVEL: "error",
          ...hub.nodeEnv,
        });
        node = await startNode(config, { chain: hub.nodeChain, logger: silentLogger, workers: false, port });
      } catch (err) {
        lastError = err;
        // A port taken between choosing it and binding it is worth another try; anything else is not.
        if (!/EADDRINUSE|address already in use/i.test(String(err instanceof Error ? err.message : err))) break;
      }
    }
    if (!node) {
      const why = lastError instanceof Error ? lastError.message : String(lastError);
      throw new SwarmStartError(
        `the clearing node did not start: ${why}\nWhat to do: check that Node.js is 22.18 or newer (node -v), that ${tmp} is writable, and that nothing blocks 127.0.0.1 ports; then run the command again.`,
      );
    }
    const started = node;
    cleanups.push(() => started.stop());
    const nodeUrl = node.url;
    const nodeKey = node.services.chain.nodeKey;

    const listService: World["listService"] = async (svc) => {
      const res = await fetch(`${nodeUrl}/v1/providers`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: svc.name, description: svc.description, payee: svc.payee, priceAtomic: svc.price.toString(), resource: svc.resource, category: "swarm" }),
      });
      if (res.status !== 201) throw new Error(`listing "${svc.name}" at the clearing node failed: HTTP ${res.status} ${await res.text()}`);
      const r = (await res.json()) as Registered;
      return paywall({ nodeUrl, providerId: r.id, apiKey: r.apiKey, price: svc.price, description: svc.description });
    };

    // On a real chain the sub-accounts must exist before they can own anything, and each one signs for itself.
    // The simulated hub has no accounts to create: its wallet actions take the account name as given.
    let wallets: Pick<DemoHub["wallets"], "fund" | "openBudget"> = hub.wallets;
    if (hub.kind === "sandbox") {
      const { createSwarmAccounts } = await import("./sandbox.ts");
      wallets = await createSwarmAccounts(hub, parent, specs.all, say);
      say("   Budgets: every agent funds and opens its own Budget from its own account.");
    }

    const roster: RosterEntry[] = specs.all.map((a) => ({ account: a.account, role: a.role, publicKey: a.key.publicKey, ...(a.role === "buyer" && a.dataHost ? { dataHost: true } : {}) }));
    const hosts = specs.buyers.filter((b) => b.dataHost).map((b) => b.account);
    const sellerAccounts = specs.sellers.map((x) => x.account);
    const clientOptions: ClientOptions = { network: hub.chain.network, hub: names.hub, nodeUrl, trustedNodeKey: nodeKey };

    // Every agent's sub-account funds and opens its own Budget from its own wallet, then registers it with the node.
    const open = async (a: AgentSpec): Promise<BudgetFacts> => {
      const plan = budgetPlan(scenario, a);
      const supplier = a.role === "seller" ? storageSupplierOf(roster, a.account) : null;
      const payees = a.role === "buyer" ? sellerAccounts : [...(supplier ? [supplier] : []), ...hosts];
      const policy: Policy = { perCallCap: plan.perCallCap.toString(), dailyCap: plan.dailyCap.toString(), maxCallsPerMinute: 0, purpose: plan.purpose };
      const owner = new OwnerClient({ nodeUrl, network: hub.chain.network, hub: names.hub, token: names.token, owner: a.account, settler: names.operator, adminToken });
      const b = owner.createBudget({ agentPk: a.key.publicKey, cap: plan.cap, validForSeconds: 12 * 3600, payees, policy, salt: seededSalt(scenario.seed, `budget|${a.account}`) });
      const opened = await wallets.openBudget(a.account, b.terms, plan.escrow);
      if (opened !== b.budgetId) throw new Error(`the hub opened Budget ${opened} for ${a.account}, not ${b.budgetId}`);
      await owner.submit({ terms: b.terms, policy, label: `${a.role}-${a.index} (${a.strategy})` });
      return { budgetId: b.budgetId, cap: plan.cap, escrow: plan.escrow, policy, payees };
    };
    const budgets = new Map<AccountId, BudgetFacts>();
    // Each account signs only its own transactions. A chain with real blocks takes them five at a time.
    const width = hub.kind === "fake" ? 1 : 5;
    // Every agent funds itself first, which registers it with the token, and only then does any Budget reach the node.
    // The node checks each payee when a Budget is registered: a seller that had not minted yet would be "not registered
    // with the token", and the payee check would hold every payment to it.
    for (let i = 0; i < specs.all.length; i += width) {
      await Promise.all(specs.all.slice(i, i + width).map((a) => wallets.fund(a.account, budgetPlan(scenario, a).escrow)));
    }
    for (let i = 0; i < specs.all.length; i += width) {
      await Promise.all(specs.all.slice(i, i + width).map(async (a) => budgets.set(a.account, await open(a))));
    }

    const buyers = specs.buyers.map((b) => new BuyerAgent(b, budgets.get(b.account)!, clientOptions));
    const sellers = specs.sellers.map((x) => new SellerAgent(x, budgets.get(x.account)!, clientOptions));

    const servers: Listening[] = [];
    cleanups.push(() => Promise.all(servers.map((l) => l.close())).then(() => undefined));
    for (const seller of sellers) {
      const { listening, serve } = await listenLater();
      servers.push(listening);
      seller.url = listening.url;
      // Rule I1: with a single seller nobody buys storage, so nothing is listed.
      const storage = sellers.length > 1 ? await listService({ name: `Checkpoint storage by seller-${seller.spec.index}`, payee: seller.account, price: scenario.storage.price, resource: `${listening.url}/storage/block`, description: "One checkpoint storage block" }) : null;
      serve(seller.app(storage));
    }
    for (const host of buyers.filter((b) => b.spec.dataHost)) {
      const { listening, serve } = await listenLater();
      servers.push(listening);
      host.dataUrl = `${listening.url}/data/shard`;
      serve(host.dataApp(await listService({ name: `Dataset shards by buyer-${host.spec.index}`, payee: host.account, price: scenario.data.price, resource: host.dataUrl, description: "One dataset shard" })));
    }

    const clock = new ManualClock(1_000);
    const coordinator = new Coordinator({ clock });
    const openerToken = randomBytes(16).toString("hex");
    const coordinatorServer = await listen(coordinatorApp(coordinator, { openerToken }), 0);
    servers.push(coordinatorServer);

    return { scenario, hub, chain: hub.chain, node, nodeUrl, nodeKey, adminToken, parent, roster, coordinator, coordinatorUrl: coordinatorServer.url, openerToken, clock, buyers, sellers, listService, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
