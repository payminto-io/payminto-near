import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApi, type NodeServices } from "./api.ts";
import { ChainClient } from "./chain.ts";
import { agentsConfigOf, dashboardUrlOf, defaultConfirmTag, LIVE_CHAIN_IDS, redactedConfig, type Config } from "./config.ts";
import { AgentsModule } from "./agents/index.ts";
import type { ModelLayer } from "./agents/models.ts";
import type { OpsToolFactory } from "./agents/ops-tools.ts";
import { AuditLog } from "./auth/audit.ts";
import { Mailer } from "./auth/mailer.ts";
import { DEFAULT_SCRYPT_LOG_N } from "./auth/passwords.ts";
import { AuthService, DEFAULT_SESSION } from "./auth/service.ts";
import { CustomerService } from "./gateway/customers.ts";
import { SearchService } from "./search.ts";
import { BatchAttester, verifyBatchAttestation } from "./eas.ts";
import { Database } from "./db/database.ts";
import { EventBus } from "./events.ts";
import { Gateway } from "./gateway/index.ts";
import { FundsTracker } from "./funds.ts";
import { CoordinatorHspAdapter } from "./hsp/coordinator.ts";
import { LocalHspAdapter } from "./hsp/local.ts";
import type { HspPort } from "./hsp/port.ts";
import { Ledger } from "./ledger.ts";
import { createLogger, type Logger } from "./logger.ts";
import { MandateService } from "./mandates.ts";
import { Metrics } from "./metrics.ts";
import { TokenBuckets } from "./ratelimit.ts";
import { pruneTable } from "./retention.ts";
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
  /** Override the HSP port (tests, or the official @hsp/sdk later). */
  hsp?: HspPort;
  /** Run background workers (auto-settle, funds refresh, revocation scan, HSP retry, gateway workers). Default true. */
  workers?: boolean;
  /** Listen on this port instead of config.port (0 = random). */
  port?: number;
  /** HTTP client for the HSP Coordinator (tests use a fake coordinator). */
  fetch?: typeof fetch;
  /** Merchant AI agents: replaces parts of the model layer (tests use a scripted model). */
  models?: Partial<ModelLayer>;
  /** Merchant AI agents: HTTP client for model providers (tests point it at mock servers). */
  modelFetch?: typeof fetch;
  /** Merchant AI agents: replaces the ops agents' merchant tools (tests). */
  agentTools?: OpsToolFactory;
};

/** Builds every service, checks the chain and database agree with the config, recovers interrupted batches, and listens. */
export async function startNode(config: Config, opts: CreateNodeOptions = {}): Promise<ClearingNode> {
  const log = opts.logger ?? createLogger({ level: config.logLevel, base: { service: "clearing-node" } });
  const chain = new ChainClient({
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    rpcFallbackUrls: config.rpcFallbackUrls,
    hub: config.hub,
    token: config.token,
    operatorKey: config.operatorKey,
    confirmTag: config.confirmTag ?? defaultConfirmTag(config.chainId),
    tx: config.tx,
    rpcRetries: config.rpcRetries,
  });

  const rpcChainId = await chain.public.getChainId();
  if (rpcChainId !== config.chainId) throw new Error(`RPC_URL serves chain ${rpcChainId}, expected CHAIN_ID ${config.chainId}`);
  if (!(await chain.isContract(config.hub))) throw new Error(`No contract at HUB_ADDRESS ${config.hub} on chain ${config.chainId}`);
  if (!(await chain.isContract(config.token))) throw new Error(`No contract at TOKEN_ADDRESS ${config.token} on chain ${config.chainId}`);
  const attester = config.easAttest ? new BatchAttester(chain) : null;
  if (attester) await attester.assertAvailable();
  let hspRegistry: Awaited<ReturnType<CoordinatorHspAdapter["init"]>> | null = null;

  const db = new Database(config.dbPath);
  let started = false;
  try {
    const applied = db.migrate();
    const store = new Store(db);
    // A database belongs to exactly one (chain, hub, token); mixing them would corrupt positions.
    for (const [key, value] of [
      ["chain_id", String(config.chainId)],
      ["hub", chain.hub],
      ["token", chain.token],
    ] as const) {
      const existing = store.getMeta(key);
      if (existing === undefined) store.setMeta(key, value);
      else if (existing.toLowerCase() !== value.toLowerCase()) {
        throw new Error(`Database ${config.dbPath} belongs to ${key}=${existing}, not ${value}. Use a different DB_PATH.`);
      }
    }

    const events = new EventBus(db);
    const ledger = new Ledger(db);
    const funds = new FundsTracker(store, chain, events, log.child({ component: "funds" }));
    let hsp: HspPort;
    if (opts.hsp) hsp = opts.hsp;
    else if (config.hsp.mode === "coordinator") {
      const coordinator = new CoordinatorHspAdapter({
        url: config.hsp.coordinatorUrl!,
        apiKey: config.hsp.apiKey!,
        chainName: config.hsp.chainName,
        verifyingContract: config.hsp.verifyingContractPinned ? config.hsp.verifyingContract : undefined,
        requiredCapabilities: config.hsp.requiredCapabilities,
        fetch: opts.fetch,
      });
      // Resolves the registry name and verifyingContract by chain id; refuses to start on a pin mismatch.
      hspRegistry = await coordinator.init(config.chainId);
      hsp = coordinator;
    } else {
      hsp = new LocalHspAdapter({
        chainId: config.chainId,
        hub: config.hub,
        verifyingContract: config.hsp.verifyingContract,
        publicClient: chain.public,
        adapterAccount: chain.operator,
        verifyAttestation: attester
          ? (uid, batchId) => verifyBatchAttestation(chain, uid, { batchId, attester: chain.operator.address, hub: chain.hub })
          : undefined,
      });
    }
    const vouchers = new VoucherService({
      db,
      store,
      chain,
      ledger,
      events,
      funds,
      log: log.child({ component: "vouchers" }),
      denialDedupSec: config.denials.dedupWindowSec,
    });
    const mandates = new MandateService({ db, store, chain, events, log: log.child({ component: "mandates" }), fromBlock: config.deployBlock });
    const settlement = new SettlementService({
      db,
      store,
      chain,
      ledger,
      events,
      funds,
      hsp,
      log,
      cosignTimeoutSec: config.hsp.cosignTimeoutSec,
      attester,
    });
    const token = { address: chain.token, ...(await chain.tokenMeta()) };
    const limiters = {
      provider: new TokenBuckets(config.rateLimit.provider),
      ip: new TokenBuckets(config.rateLimit.ip),
    };
    // Payminto Gateway (docs/GATEWAY.md), on when the config has a gateway section.
    const gateway = config.gateway
      ? await Gateway.create({
          config: config.gateway,
          chainId: config.chainId,
          db,
          chain,
          vouchers,
          settlement,
          attester,
          log: log.child({ component: "gateway" }),
          token,
          publicUrl: config.publicUrl,
        })
      : null;
    // Accounts (docs/PRODUCT.md sections 4 and 10).
    const audit = new AuditLog(db);
    const metrics = new Metrics();
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
        chainId: config.chainId,
      },
    });
    const customers = gateway ? new CustomerService(db) : null;
    // Merchant AI agents (docs/AGENTS.md), on with the gateway: they belong to its businesses.
    const agentsConfig = agentsConfigOf(config);
    if (agentsConfig.enabled && LIVE_CHAIN_IDS.includes(config.chainId) && agentsConfig.usingDevKey) {
      throw new Error(`AGENT_SECRETS_KEY: required on chain ${config.chainId} while agents are on; the documented dev key is refused`);
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
      mandates,
      settlement,
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
    const prune = () => {
      const denials = pruneTable(db, "denials", config.denials.maxRows);
      const evts = pruneTable(db, "events", config.eventsMaxRows);
      limiters.provider.prune();
      limiters.ip.prune();
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
      every(15_000, "revocation scan", () => mandates.scanRevocations());
      every(15_000, "hsp retry", () => settlement.retryHsp());
      // About one block: promotes included batches once the CONFIRM_TAG head passes them, and handles reorgs.
      every(2_000, "finality", () => settlement.trackFinality());
      every(60_000, "retention", async () => prune());
      gateway?.start({ watchMs: config.gateway!.watchIntervalMs });
      agents?.start();
      if (config.settleIntervalSec > 0) {
        every(config.settleIntervalSec * 1000, "auto-settle", async () => {
          if (store.unsettledCallCount() >= config.settleMinCalls) await settlement.settle("interval");
        });
      }
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
      operator: chain.operator.address,
      migrationsApplied: applied,
      confirmTag: chain.confirmTag,
      hspRegistry,
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
        await Promise.race([settlement.idle(), new Promise((r) => setTimeout(r, 60_000).unref())]);
        // Agent runs in flight go back to the queue (their attempt given back) and their run keys are revoked.
        await agents?.stop();
        await gateway?.stop();
        db.close();
        log.info("stopped");
      })());

    return { services, app, url, port, stop };
  } finally {
    if (!started) db.close();
  }
}
