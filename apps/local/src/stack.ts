/**
 * The local stack: a fresh near-sandbox node with the mock USDC and the locked hub (the demo's hub factory), the named
 * local accounts, the real clearing node with its real NearRpcChain, the local signer, the paid services with the
 * agent remote, first-run setup, optional activity, and the dashboard.
 *
 * Everything started here is stopped by `stop()`, in reverse order, on every exit path.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createHub, type DemoHub } from "@payminto/demo";
import { createLogger, loadConfig, startNode, type ClearingNode } from "@payminto/node";
import { keypairFromSeed, type Id32, type PublicKey } from "@payminto/protocol";
import type { Hono } from "hono";
import { createLogger as createRelayerLogger, loadConfig as loadRelayerConfig, startRelayer, type RunningRelayer } from "@payminto/relayer";
import { FakeOneClick } from "@payminto/near-addons/intents/fake-server";
import { createLocalAccounts, drainNear, type LocalAccounts } from "./accounts.ts";
import { runActivity, type ActivityResult } from "./activity.ts";
import { AgentDesk } from "./agents.ts";
import { DASHBOARD_DIR, NETWORK, type LocalOptions, type Ports } from "./config.ts";
import { DashboardProcess } from "./dashboard.ts";
import { assertLocalDatabase, clearLock, dataPaths, DataError, reapStaleDashboard, runningStack, wipeData, writeLock, type DataPaths } from "./data.ts";
import { choosePorts } from "./ports.ts";
import { remoteApp } from "./remote.ts";
import { registerServices, type RegisteredService } from "./services.ts";
import { assertSandboxOnly, createSignerApp } from "./signer.ts";
import { chainIdOf, nearBackend, rpc } from "./signer-near.ts";
import { runSetup, signerClient, type SetupResult, type SignerClient } from "./setup.ts";

export type Urls = { dashboard: string; node: string; signer: string; services: string; remote: string; relayer: string; rpc: string; oneclick: string };

export type Stack = {
  opts: LocalOptions;
  paths: DataPaths;
  ports: Ports;
  urls: Urls;
  hub: DemoHub;
  accounts: LocalAccounts;
  node: ClearingNode;
  nodeKey: PublicKey;
  signerToken: string;
  signer: SignerClient;
  desk: AgentDesk;
  services: RegisteredService[];
  setup: SetupResult;
  activity: ActivityResult | null;
  dashboard: DashboardProcess | null;
  /** The fake 1Click server of the simulated any-chain checkout; its deliveries are real transfers on this chain. */
  oneclick: FakeOneClick;
  /** Calls back once when a part of the stack dies on its own. */
  onCrash(cb: (what: string, detail: string) => void): void;
  stop(): Promise<void>;
};

export class StartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartError";
  }
}

type Fetch = Hono["fetch"];

function listen(app: Hono | Fetch, port: number): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = serve({ fetch: typeof app === "function" ? app : app.fetch, port, hostname: "127.0.0.1" }, () =>
      resolve({
        close: () =>
          new Promise<void>((r) => {
            s.close(() => r());
            (s as Server).closeAllConnections?.();
          }),
      }),
    ) as Server;
    s.once("error", reject);
  });
}

const SANDBOX_HELP = [
  "pnpm local needs the near-sandbox 2.14.0 binary: a local NEAR node.",
  "It is looked for in NEAR_SANDBOX_BIN_PATH, then where the contract's cargo tests put it (contracts-near/target), then in ~/.near-kit/sandbox/bin.",
  "When it is nowhere, near-kit downloads it once from NEAR's release bucket (about 30 MB) into ~/.near-kit/sandbox/bin; that needs a network connection the first time only.",
  "Go online and run pnpm local again, or set NEAR_SANDBOX_BIN_PATH to a near-sandbox 2.14.0 binary you already have.",
].join("\n");

export async function startStack(opts: LocalOptions, say: (line: string) => void): Promise<Stack> {
  const cleanups: Array<() => Promise<void> | void> = [];
  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => {});
    })());
  const crashListeners: Array<(what: string, detail: string) => void> = [];
  let crashed = false;
  const crash = (what: string, detail: string) => {
    if (crashed || stopping) return;
    crashed = true;
    for (const l of crashListeners) l(what, detail);
  };

  try {
    const paths = dataPaths();
    const check = opts.mode === "check";

    // One stack at a time: a second one would delete the first one's database.
    const other = runningStack(paths);
    if (other) throw new StartError(`pnpm local is already running (process ${other.pid}, started ${other.startedAt}${other.dashboardUrl ? `, dashboard ${other.dashboardUrl}` : ""}). Stop it with Ctrl-C in its terminal first.`);
    if (reapStaleDashboard(paths, DASHBOARD_DIR)) say("Stopped the dashboard dev server an earlier run left behind.");

    const ports = await choosePorts(opts.ports, !check);
    const urls: Urls = {
      dashboard: `http://localhost:${ports.dashboard}`,
      node: `http://127.0.0.1:${ports.node}`,
      signer: `http://127.0.0.1:${ports.signer}`,
      services: `http://127.0.0.1:${ports.services}`,
      remote: `http://127.0.0.1:${ports.services}/`,
      relayer: `http://127.0.0.1:${ports.relayer}`,
      rpc: "",
      oneclick: "",
    };
    // The dashboard is reached as localhost; 127.0.0.1 is the same page for a person who types it.
    const dashboardOrigins = [urls.dashboard, `http://127.0.0.1:${ports.dashboard}`];

    // A database from an earlier run describes a chain that is gone, so every start begins clean. See data.ts.
    const wiped = wipeData(paths.dir);
    if (wiped.removed) say(`Removed the data of the previous run (${paths.dir}): its chain stopped with it, so its database describes Budgets and batches that no longer exist.`);
    mkdirSync(paths.logs, { recursive: true });
    writeLock(paths, { pid: process.pid, startedAt: new Date().toISOString(), mode: opts.mode });
    cleanups.push(() => clearLock(paths));

    // ---- 1. The chain: sandbox node, mock USDC, the hub from the committed wasm, locked. The demo's hub factory.
    const nodeSigningSeed = randomBytes(32).toString("hex");
    let downloading = false;
    const hubSay = (line: string) => {
      if (line.includes("is not on this machine yet")) downloading = true;
      say(line);
    };
    let hub: DemoHub;
    try {
      hub = await createHub("sandbox", { runDir: paths.logs, checkoutKey: keypairFromSeed(Buffer.from(nodeSigningSeed, "hex")).publicKey, say: hubSay });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const binary = downloading || /NEAR_SANDBOX_BIN_PATH|near-sandbox binary|download|ENOTFOUND|fetch failed|ECONNREFUSED|getaddrinfo/i.test(message);
      throw new StartError(binary ? `The local NEAR node could not start: ${message}\n\n${SANDBOX_HELP}` : `The local NEAR node could not start: ${message}\nIts own log, if it got that far, is ${paths.sandboxLog}.`);
    }
    cleanups.push(() => hub.close());
    if (!hub.rpcUrl || !hub.sandbox) throw new StartError("the hub factory returned no sandbox");
    urls.rpc = hub.rpcUrl;
    const rpcUrl = hub.rpcUrl;

    const accounts = await createLocalAccounts(hub, say);

    // ---- 1b. The fake 1Click server (NEAR Intents, simulated). It never talks to the live API. A delivery is a real
    //      ft_transfer of mock USDC from the local solver account to the merchant's account, so the node's delivery
    //      check reads a real transaction on this chain.
    const oneclickLog: WriteStream = createWriteStream(join(paths.logs, "oneclick-fake.log"), { flags: "a" });
    cleanups.push(() => new Promise<void>((r) => oneclickLog.end(() => r())));
    const signers = hub.sandbox.signers;
    const oneclick = new FakeOneClick({
      stepMs: check ? 300 : 2_000,
      refundAfterMs: check ? 600 : 20_000,
      log: (line) => void oneclickLog.write(`${new Date().toISOString()} ${line}\n`),
      accountExists: async (id) => {
        try {
          await rpc(rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: id });
          return true;
        } catch {
          return false;
        }
      },
      deliver: async ({ recipient, amount }) => {
        const txHash = await signers.built(accounts.solver, `deliver ${amount} to ${recipient}`, (b) =>
          b.functionCall(hub.names.token, "ft_transfer", { receiver_id: recipient, amount: amount.toString(), memo: "NEAR Intents delivery (simulated)" }, { gas: "30 Tgas", attachedDeposit: 1n }),
        );
        oneclickLog.write(`${new Date().toISOString()} delivered ${amount} to ${recipient} in tx ${txHash}\n`);
        return { txHash };
      },
    });
    urls.oneclick = await oneclick.listen(0);
    cleanups.push(() => oneclick.close());
    say(`   NEAR Intents (simulated): a fake 1Click server on ${urls.oneclick}, signing with a public test key; ${accounts.solver} delivers its mock USDC on this chain.`);

    // ---- 2. The clearing node: the real node, its real NearRpcChain, the gateway on, a database that passes the guard.
    assertLocalDatabase(paths.db);
    const nodeLog: WriteStream = createWriteStream(paths.nodeLog, { flags: "a" });
    cleanups.push(() => new Promise<void>((r) => nodeLog.end(() => r())));
    let setupCode: string | null = null;
    const hubReadiness: string[] = [];
    const logger = createLogger({
      level: "info",
      base: { service: "clearing-node" },
      sink: (line) => {
        nodeLog.write(`${line}\n`);
        // The one-time setup code, read where a person would read it: in the node's log.
        const m = /\[setup\] Open \S+ and enter code (\S+)/.exec(line);
        if (m) setupCode = m[1]!;
        // What the node says at startup about its standing on the hub (receipt key, prepaid storage).
        if (line.includes("hub readiness")) hubReadiness.push((JSON.parse(line) as { msg: string }).msg);
      },
    });
    // Built from nothing but this run's values: no variable of the caller's environment reaches the node, least of
    // all DB_PATH.
    const config = loadConfig({
      PORT: String(ports.node),
      HOST: "127.0.0.1",
      NETWORK,
      HUB_ACCOUNT: hub.names.hub,
      TOKEN_ACCOUNT: hub.names.token,
      OPERATOR_ACCOUNT: hub.names.operator,
      NODE_SIGNING_SEED: nodeSigningSeed,
      ADMIN_TOKEN: randomBytes(32).toString("hex"),
      DB_PATH: paths.db,
      PUBLIC_URL: urls.node,
      PUBLIC_CHECKOUT_URL: urls.dashboard,
      PUBLIC_DASHBOARD_URL: urls.dashboard,
      CORS_ORIGINS: dashboardOrigins.join(","),
      GATEWAY_ENABLED: "true",
      PLATFORM_FEE_ACCOUNT: accounts.by.platform.accountId,
      // A person settles and pays out by hand in the walkthrough, so neither runs on a timer.
      SETTLE_INTERVAL_SEC: "0",
      PAYOUT_INTERVAL_SEC: "0",
      FUNDS_REFRESH_SEC: "5",
      GATEWAY_WATCH_INTERVAL_MS: "1000",
      // Local logins only: the default cost makes every sign-in take about a second for no gain here.
      // The payee check is on, as on any node. A sandbox has no indexer, so account ages are not checked.
      PAYEE_CHECK_INDEXER: "off",
      PASSWORD_HASH_COST: "14",
      // Every browser reaches the node through the dashboard's /api path, so the node sees one client address. The
      // default of 20 auth requests a minute per address is then shared by every tab, and a person clicking around
      // hits it; on one machine there is nobody to keep out.
      AUTH_RATE_LIMIT_PER_MIN: "600",
      LOG_LEVEL: "info",
      // The any-chain checkout, simulated: the fake 1Click server, its test key, and this chain standing in for mainnet.
      INTENTS_CHECKOUT: "simulated",
      ONECLICK_BASE_URL: urls.oneclick,
      ONECLICK_MANAGER_PUBLIC_KEY: oneclick.managerPublicKey,
      NEAR_MAINNET_RPC_URL: rpcUrl,
      INTENTS_USDC_CONTRACT: hub.names.token,
      INTENTS_DELIVERY_SENDERS: accounts.solver,
      ...hub.nodeEnv,
    });
    let node: ClearingNode;
    try {
      node = await startNode(config, { logger });
    } catch (err) {
      throw new StartError(`The clearing node could not start: ${err instanceof Error ? err.message : String(err)}\nIts log is ${paths.nodeLog}.`);
    }
    cleanups.push(() => node.stop());
    // The node checks at startup that the hub holds its receipt key and enough prepaid storage to settle. The hub
    // factory sets both up; if the node still reports a problem, this stack would accept calls it cannot settle.
    if (hubReadiness.length > 0) throw new StartError(`The clearing node reports that it is not ready on the hub:\n  - ${hubReadiness.join("\n  - ")}\nIts log is ${paths.nodeLog}.`);
    const nodeKey = node.services.chain.nodeKey;
    say(`2. Clearing node: ${urls.node} (the real node, NearRpcChain against ${rpcUrl}, gateway on), database ${paths.db}, log ${paths.nodeLog}`);

    // ---- 3. The local signer.
    const signerToken = randomBytes(32).toString("base64url");
    const holders = accounts.list.map((a) => ({ accountId: a.accountId, role: a.role, does: a.does, publicKey: a.publicKey, secretKey: a.secretKey, near: hub.sandbox!.signers.get(a.accountId).near }));
    const backend = nearBackend({ rpcUrl, token: hub.names.token, holders });
    await assertSandboxOnly(backend);
    const signerLog: WriteStream = createWriteStream(paths.signerLog, { flags: "a" });
    cleanups.push(() => new Promise<void>((r) => signerLog.end(() => r())));
    const signerApp = createSignerApp({
      backend,
      token: signerToken,
      allowedOrigins: dashboardOrigins,
      log: (line) => {
        signerLog.write(`${new Date().toISOString()} ${line}\n`);
        if (!check) say(`   [signer] ${line}`);
      },
    });
    const signerServer = await listen(signerApp, ports.signer);
    cleanups.push(() => signerServer.close());
    const signer = signerClient(urls.signer, signerToken);
    say(`3. Local signer: ${urls.signer} (127.0.0.1 only, this run's token, ${accounts.list.length} local accounts, log ${paths.signerLog}). DEVELOPMENT ONLY: it signs for the local sandbox and nothing else.`);

    // ---- 3b. The gas relayer (apps/relayer): the real service, with its own funded account, paying only for the
    //      listed zero-deposit calls to this hub. An owner signs a NEP-366 delegate; the relayer pays the gas.
    const relayerLog: WriteStream = createWriteStream(paths.relayerLog, { flags: "a" });
    cleanups.push(() => new Promise<void>((r) => relayerLog.end(() => r())));
    let relayer: RunningRelayer;
    try {
      // Built from this run's values only, like the node's configuration.
      const relayerConfig = loadRelayerConfig({
        RELAYER_ACCOUNT: accounts.relayer.accountId,
        RELAYER_KEY: accounts.relayer.secretKey,
        HUB_ACCOUNT: hub.names.hub,
        NETWORK,
        RPC_URL: rpcUrl,
        PORT: String(ports.relayer),
        HOST: "127.0.0.1",
        CORS_ORIGINS: dashboardOrigins.join(","),
        LOG_LEVEL: "info",
      });
      relayer = await startRelayer(relayerConfig, { logger: createRelayerLogger({ level: "info", base: { service: "relayer" }, sink: (line) => void relayerLog.write(`${line}\n`) }), gasLedger: null });
    } catch (err) {
      throw new StartError(`The gas relayer could not start: ${err instanceof Error ? err.message : String(err)}\nIts log is ${paths.relayerLog}.`);
    }
    // A relay in flight would hold the listener open for a minute; at shutdown nothing is worth that wait.
    cleanups.push(() => Promise.race([relayer.stop(), new Promise<void>((r) => setTimeout(r, 3_000).unref())]));
    say(`   Gas relayer: ${urls.relayer} (${accounts.relayer.accountId} pays the gas for revoke_budget, reclaim and payout on ${hub.names.hub} and for nothing else), log ${paths.relayerLog}`);

    // ---- 4. First-run setup through HTTP, then the paid services and the agent remote.
    if (!setupCode) throw new StartError(`The node did not print a setup code. Its log is ${paths.nodeLog}.`);
    say("4. First-run setup, through the node's HTTP API and the local signer:");
    const desk = new AgentDesk({ nodeUrl: urls.node, network: NETWORK, hub: hub.names.hub, nodeKey, storePath: paths.receipts });
    cleanups.push(() => desk.close());
    let services: RegisteredService[] = [];
    let seededFirst: Id32[] = [];
    const setup = await runSetup({
      nodeUrl: urls.node,
      dashboardUrl: urls.dashboard,
      setupCode,
      network: NETWORK,
      hub: hub.names.hub,
      token: hub.names.token,
      settler: hub.names.operator,
      accounts,
      signer,
      desk,
      loginsPath: paths.logins,
      say,
      registerServices: async (owner) => {
        const reg = await registerServices({ session: owner, nodeUrl: urls.node, baseUrl: urls.services, accounts, voucherPath: paths.vouchers });
        cleanups.push(() => reg.close());
        services = reg.services;
        const app = remoteApp({ services: reg.app, desk, owner, urls, list: () => services, first: () => seededFirst, accounts, port: ports.services });
        const server = await listen(app, ports.services);
        cleanups.push(() => server.close());
        return reg.services;
      },
    });
    seededFirst = [setup.budgets.alice.budgetId, setup.budgets.bob.budgetId, setup.budgets.carol.budgetId];
    // Two spare agent keys, for Budgets a person opens in the dashboard.
    desk.newKey("Spare key 1");
    desk.newKey("Spare key 2");
    // Carol opened and funded her Budget like anyone else. Now her NEAR goes back to the root, so she is the owner
    // who cannot pay for gas: her own revoke is refused by the chain, and the relayer's is not.
    say(`   ${accounts.by.carol.accountId} gives up her NEAR, to be the owner who cannot pay for gas:`);
    await drainNear(hub, rpcUrl, accounts.by.carol.accountId, say);

    // ---- 5. A little real activity, so every page has something true to show.
    let activity: ActivityResult | null = null;
    if (!opts.empty) {
      say("5. Activity, through the real SDK and the same routes a person uses:");
      activity = await runActivity({ urls, hub, accounts, setup, desk, services, signer, say });
    }

    // ---- 6. The dashboard.
    let dashboard: DashboardProcess | null = null;
    if (!opts.noDashboard) {
      say(`${opts.empty ? 5 : 6}. Dashboard: starting next dev in apps/dashboard (the first start compiles for a while), log ${paths.dashboardLog}`);
      dashboard = DashboardProcess.spawn({ port: ports.dashboard, nodeUrl: urls.node, signerUrl: urls.signer, signerToken, relayerUrl: urls.relayer, rpcUrl: "", logPath: paths.dashboardLog });
      const d = dashboard;
      cleanups.push(() => d.stop());
      process.on("exit", () => d.killSync());
      writeLock(paths, { pid: process.pid, startedAt: new Date().toISOString(), mode: opts.mode, dashboardPid: d.pid, dashboardUrl: d.url });
      await d.ready();
      d.onExit((how) => crash("The dashboard dev server", `it stopped on its own (${how}). Its log is ${paths.dashboardLog}.`));
    }

    // ---- Watch the sandbox: three missed status reads in a row means the chain is gone.
    let missed = 0;
    const watch = setInterval(() => {
      void rpc<unknown>(rpcUrl, "status", [], 2_000).then(
        () => (missed = 0),
        () => {
          if (++missed >= 3) crash("The local NEAR node (near-sandbox)", `it stopped answering on ${rpcUrl}. Its log is ${paths.sandboxLog}.`);
        },
      );
    }, 2_000);
    watch.unref();
    cleanups.push(() => clearInterval(watch));

    return {
      opts,
      paths,
      ports,
      urls,
      hub,
      accounts,
      node,
      nodeKey,
      signerToken,
      signer,
      desk,
      services,
      setup,
      activity,
      dashboard,
      oneclick,
      onCrash: (cb) => void crashListeners.push(cb),
      stop,
    };
  } catch (err) {
    await stop();
    if (err instanceof DataError) throw new StartError(err.message);
    throw err;
  }
}

export { chainIdOf };
