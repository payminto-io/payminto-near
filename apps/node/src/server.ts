import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApi, type NodeServices } from "./api.ts";
import { keypairFromSeed, networkFor, type Chain } from "@payminto/protocol";
import { NearRpcChain } from "@payminto/chain/node";
import { ChainClient } from "./chain.ts";
import { agentsConfigOf, dashboardUrlOf, DEFAULT_UNSIGNED_LIMIT, LIVE_NETWORKS, redactedConfig, type Config } from "./config.ts";
import { AgentsModule } from "./agents/index.ts";
import type { ModelLayer } from "./agents/models.ts";
import type { OpsToolFactory } from "./agents/ops-tools.ts";
import { AuditLog } from "./auth/audit.ts";
import { Mailer } from "./auth/mailer.ts";
import { DEFAULT_SCRYPT_LOG_N } from "./auth/passwords.ts";
import { AuthService, DEFAULT_SESSION } from "./auth/service.ts";
import { CustomerService } from "./gateway/customers.ts";
import { SearchService } from "./search.ts";
import { Database } from "./db/database.ts";
import { EventBus } from "./events.ts";
import { Gateway } from "./gateway/index.ts";
import { FundsTracker } from "./funds.ts";
import { hubReadinessProblems } from "./hub-readiness.ts";
import { Ledger } from "./ledger.ts";
import { createLogger, type Logger } from "./logger.ts";
import { BudgetService } from "./budgets.ts";
import { Metrics } from "./metrics.ts";
import { TokenBuckets } from "./ratelimit.ts";
import { pruneTable } from "./retention.ts";
import { Mutex } from "./mutex.ts";
import { NearRpc, type AccessKeyReader, type TxReader } from "./near-rpc.ts";
import { createPayeeService, type PayeeCheckSources } from "./payees/index.ts";
import { PayoutService } from "./payouts.ts";
import { SettlementService } from "./settlement.ts";
import { Store } from "./store.ts";
import { VoucherService } from "./vouchers.ts";

export type ClearingNode = {
  services: NodeServices;
  app: ReturnType<typeof createApi>;
  /** Base URL once listening. */
  url: string;
  port: number;
  stop(): Promise<void>;
};

export type CreateNodeOptions = {
  logger?: Logger;
  /** The chain to use instead of NEAR RPC (tests and `DEMO_CHAIN=fake` pass a FakeChain). */
  chain?: Chain;
  /**
   * The node-local NEAR RPC reads (access keys, transaction contents). Defaults to RPC_URL when no chain is injected,
   * and to none with an injected chain: payout proofs are then refused and refunds are checked for finality only.
   */
  nearRpc?: (AccessKeyReader & TxReader) | null;
  /** What the payee check reads. Defaults to RPC_URL when no chain is injected, and to none (check off) with an injected chain. */
  payeeCheck?: PayeeCheckSources | null;
  /** Run background workers (auto-settle, funds refresh, revocation scan, payouts, gateway workers). Default true. */
  workers?: boolean;
  /** Listen on this port instead of config.port (0 = random). */
  port?: number;
  /** Merchant AI agents: replaces parts of the model layer (tests use a scripted model). */
  models?: Partial<ModelLayer>;
  /** Merchant AI agents: HTTP client for model providers (tests point it at mock servers). */
  modelFetch?: typeof fetch;
  /** Merchant AI agents: replaces the ops agents' merchant tools (tests). */
  agentTools?: OpsToolFactory;
  /**
   * The clock the clearing core reads, in milliseconds (tests move it instead of sleeping). It decides policy windows,
   * when a Budget's funds were read and how old that snapshot is, so all three always agree. Default `Date.now`.
   */
  clockMs?: () => number;
};

/** Builds every service, checks the chain and database agree with the config, recovers interrupted batches, and listens. */
export async function startNode(config: Config, opts: CreateNodeOptions = {}): Promise<ClearingNode> {
  const log = opts.logger ?? createLogger({ level: config.logLevel, base: { service: "clearing-node" } });
  const seam = opts.chain ?? new NearRpcChain({ hub: config.hub, token: config.token, network: config.network, rpcUrl: config.rpcUrl, operator: config.operator, operatorKey: config.operatorKey });
  const chain = new ChainClient(seam, keypairFromSeed(Buffer.from(config.nodeSigningSeed, "hex")));
  // RPC reads the Chain seam does not carry (payout proof keys, refund transactions). An injected chain brings its own or none.
  const rpc: (AccessKeyReader & TxReader) | null = opts.chain ? (opts.nearRpc ?? null) : (opts.nearRpc ?? new NearRpc(config.rpcUrl));

  const db = new Database(config.dbPath);
  let started = false;
  try {
    const applied = db.migrate();
    const store = new Store(db);
    // A database belongs to exactly one (chain, hub, token); mixing them would corrupt positions.
    for (const [key, value] of [
      ["network", config.network],
      ["hub", chain.hub],
      ["token", chain.token],
    ] as const) {
      const existing = store.getMeta(key);
      if (existing === undefined) store.setMeta(key, value);
      else if (existing !== value) {
        throw new Error(`Database ${config.dbPath} belongs to ${key}=${existing}, not ${value}. Use a different DB_PATH.`);
      }
    }

    const events = new EventBus(db);
    const ledger = new Ledger(db);
    const clockMs = opts.clockMs ?? (() => Date.now());
    const funds = new FundsTracker(store, chain, events, log.child({ component: "funds" }), clockMs);
    const payees = createPayeeService(config, { injectedChain: !!opts.chain, sources: opts.payeeCheck }, { db, events, log: log.child({ component: "payees" }), operator: chain.operator, token: chain.token, dashboardUrl: dashboardUrlOf(config) });
    const vouchers = new VoucherService({
      db,
      payees,
      store,
      chain,
      ledger,
      events,
      funds,
      log: log.child({ component: "vouchers" }),
      denialDedupSec: config.denials.dedupWindowSec,
      fundsMaxAgeMs: config.fundsMaxAgeMs,
      ...(config.newPayees ? { newPayees: config.newPayees } : {}),
      clockMs,
    });
    const budgets = new BudgetService({ db, store, chain, events, log: log.child({ component: "budgets" }) });
    funds.onRevokedOnChain = (id) => budgets.revokedOnChain(id);
    // Every hub write goes out from one operator key, one at a time.
    const writes = new Mutex();
    const metrics = new Metrics();
    const settlement = new SettlementService({ db, store, chain, ledger, events, funds, log, writes, metrics });
    const payouts = new PayoutService({ db, chain, events, log, writes });
    // Net creditors of a confirmed batch are queued for payout in the transaction that books the batch.
    settlement.confirmHooks.push(({ seq }) => {
      for (const n of store.batchNet(seq)) if (BigInt(n.credit) > 0n) payouts.enqueue(n.account);
    });
    // A payee that settled its own voucher holds the amount as hub credit: queued for payout like any creditor.
    settlement.sellerSettledHooks.push(({ payee }) => payouts.enqueue(payee));
    const net = networkFor(config.network);
    const token = { address: chain.token, symbol: net.token.symbol, decimals: net.token.decimals };
    const limiters = {
      provider: new TokenBuckets(config.rateLimit.provider),
      ip: new TokenBuckets(config.rateLimit.ip),
      unsigned: new TokenBuckets(config.rateLimit.unsigned ?? DEFAULT_UNSIGNED_LIMIT),
    };
    // Payminto Gateway (docs/GATEWAY.md), on when the config has a gateway section.
    const gateway = config.gateway
      ? await Gateway.create({
          config: config.gateway,
          network: config.network,
          db,
          chain,
          vouchers,
          settlement,
          payouts,
          log: log.child({ component: "gateway" }),
          token,
          publicUrl: config.publicUrl,
          accessKeys: rpc,
          txs: rpc,
        })
      : null;
    // Decision 8: refusal webhooks go out through the gateway's outbox, in the transaction that records the refusal.
    if (gateway) vouchers.onDenial = (n) => gateway.refused(n);
    // Accounts (docs/PRODUCT.md sections 4 and 10).
    const audit = new AuditLog(db);
    const mailer = new Mailer({ db, log: log.child({ component: "email" }), smtp: config.auth?.smtp ?? null });
    const auth = new AuthService({
      db,
      log: log.child({ component: "auth" }),
      mailer,
      audit,
      metrics,
      merchants: gateway?.merchants ?? null,
      settings: {
        dashboardUrl: dashboardUrlOf(config),
        allowedOrigins: config.corsOrigins.filter((o) => o !== "*"),
        adminToken: config.adminToken,
        breakGlass: config.auth?.breakGlass ?? false,
        scryptLogN: config.auth?.scryptLogN ?? DEFAULT_SCRYPT_LOG_N,
        idlePlatformSec: config.auth?.sessionIdlePlatformSec ?? DEFAULT_SESSION.idlePlatformSec,
        idleBusinessSec: config.auth?.sessionIdleBusinessSec ?? DEFAULT_SESSION.idleBusinessSec,
        absoluteSec: config.auth?.sessionAbsoluteSec ?? DEFAULT_SESSION.absoluteSec,
        rotateSec: DEFAULT_SESSION.rotateSec,
        rotateGraceSec: DEFAULT_SESSION.rotateGraceSec,
        stepUpSec: DEFAULT_SESSION.stepUpSec,
        platformName: config.gateway?.platformName ?? "Payminto",
      },
    });
    const customers = gateway ? new CustomerService(db) : null;
    // Merchant AI agents (docs/AGENTS.md), on with the gateway: they belong to its businesses.
    const agentsConfig = agentsConfigOf(config);
    if (agentsConfig.enabled && LIVE_NETWORKS.includes(config.network) && agentsConfig.usingDevKey) {
      throw new Error(`AGENT_SECRETS_KEY: required on ${config.network} while agents are on; the documented dev key is refused`);
    }
    const agents =
      gateway && agentsConfig.enabled
        ? new AgentsModule({
            config: agentsConfig,
            db,
            events,
            gateway,
            log: log.child({ component: "agents" }),
            publicUrl: config.publicUrl,
            models: opts.models,
            modelFetch: opts.modelFetch,
            tools: opts.agentTools,
          })
        : null;
    if (agents && agentsConfig.usingDevKey) log.warn("AGENT_SECRETS_KEY is unset: model API keys are sealed with the documented dev key (local chains only)");
    const search = new SearchService({ db, customers, token });
    auth.ensureSetupCode();
    if (auth.ownerExists() && auth.settings.breakGlass) log.warn("ADMIN_TOKEN_BREAK_GLASS=true: the recovery key works on every route; every use is audited");
    const services: NodeServices = {
      config,
      db,
      store,
      chain,
      ledger,
      events,
      vouchers,
      budgets,
      funds,
      payees,
      settlement,
      payouts,
      log,
      token,
      sseClosers: new Set(),
      metrics,
      limiters,
      gateway,
      auth,
      search,
      customers,
      agents,
    };
    const app = createApi(services);

    await settlement.recover();
    payouts.recover();
    // What the hub requires of a settler, read from the hub: this node's receipt key registered for its account, and
    // enough prepaid storage balance for a batch. See hub-readiness.ts.
    for (const p of await hubReadinessProblems(chain).catch((err: unknown) => (log.warn("hub readiness could not be checked", { err }), []))) {
      log.error(`hub readiness: ${p.message}`, { check: p.check });
      metrics.inc("payminto_operator_alerts_total", "Conditions only the operator can resolve, by kind. Alert on any increase.", { kind: "hub_readiness" });
    }
    const prune = () => {
      const denials = pruneTable(db, "denials", config.denials.maxRows);
      const evts = pruneTable(db, "events", config.eventsMaxRows);
      limiters.provider.prune();
      limiters.ip.prune();
      limiters.unsigned.prune();
      if (denials || evts) log.info("pruned old rows", { denials, events: evts });
    };
    prune();

    const timers: NodeJS.Timeout[] = [];
    const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
      let busy = false;
      const t = setInterval(() => {
        if (busy) return;
        busy = true;
        fn()
          .catch((err) => log.warn(`${name} failed`, { err }))
          .finally(() => {
            busy = false;
          });
      }, ms);
      t.unref();
      timers.push(t);
    };
    if (opts.workers !== false) {
      every(config.fundsRefreshSec * 1000, "funds refresh", () => funds.sweep());
      // What payees settled themselves on the hub is booked between settlements too, so exposure is not overstated.
      every(config.fundsRefreshSec * 1000, "settled position sync", () => settlement.syncSettled());
      every(15_000, "revocation scan", () => budgets.scanRevocations());
      every(60_000, "retention", async () => prune());
      gateway?.start({ watchMs: config.gateway!.watchIntervalMs });
      agents?.start();
      if (config.settleIntervalSec > 0) {
        every(config.settleIntervalSec * 1000, "auto-settle", async () => {
          if (store.unsettledCallCount() >= config.settleMinCalls) await settlement.settle("interval");
        });
      }
      if ((config.payoutIntervalSec ?? 0) > 0) every(config.payoutIntervalSec! * 1000, "payouts", () => payouts.run("interval"));
    }

    // A port that is taken (EADDRINUSE) rejects here, so the caller can stop cleanly or pick another port.
    const server = await new Promise<Server>((resolve, reject) => {
      const srv = serve({ fetch: app.fetch, port: opts.port ?? config.port, hostname: config.host }, () => {
        srv.off("error", reject);
        resolve(srv as Server);
      });
      srv.once("error", reject);
    }).catch(async (err: unknown) => {
      for (const t of timers) clearInterval(t);
      await agents?.stop();
      await gateway?.stop();
      throw err;
    });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    started = true;
    log.info("clearing node listening", {
      url,
      operator: chain.operator,
      migrationsApplied: applied,
      config: redactedConfig(config),
    });

    let stopping: Promise<void> | null = null;
    const stop = () =>
      (stopping ??= (async () => {
        log.info("shutting down");
        for (const t of timers) clearInterval(t);
        for (const close of services.sseClosers) close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
          setTimeout(() => server.closeAllConnections?.(), 2_000).unref();
        });
        // Let an in-flight settlement finish booking what the chain already did, and gateway workers finish their tick.
        await Promise.race([Promise.all([settlement.idle(), payouts.idle()]), new Promise((r) => setTimeout(r, 60_000).unref())]);
        // Agent runs in flight go back to the queue (their attempt given back) and their run keys are revoked.
        await agents?.stop();
        await gateway?.stop();
        await payees.close();
        db.close();
        log.info("stopped");
      })());

    return { services, app, url, port, stop };
  } finally {
    if (!started) db.close();
  }
}
