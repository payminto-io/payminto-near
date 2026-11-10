import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PublicKey } from "@payminto/chain";
import { createRelayerApp } from "./app.ts";
import { BalanceWatch } from "./balance.ts";
import type { RelayChain } from "./chain.ts";
import { redactedConfig, redactUrl, type RelayerConfig } from "./config.ts";
import { FileGasLedger, type GasLedgerStore } from "./gas-budget.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { NearRelayChain, publicKeyOfSecret } from "./near-chain.ts";

/** A problem found at startup that the operator can fix. Its message names the variable and the fix, never a value. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

export type RunningRelayer = {
  app: Hono;
  /** Base URL once listening. */
  url: string;
  port: number;
  stop(): Promise<void>;
};

export type StartRelayerOptions = {
  logger?: Logger;
  /** The chain to use instead of NEAR RPC. Tests and `dev:fake` pass a fake. */
  chain?: RelayChain;
  gasLedger?: GasLedgerStore | null;
  /** Overrides `config.port`; 0 picks a free port. */
  port?: number;
};

/**
 * Checks, before the relayer accepts anything, that it talks to the network it was configured for and that its key can
 * sign for its account. A relayer that would fail every send should not start.
 */
export async function checkRelayerAccount(config: RelayerConfig, chain: RelayChain, relayerPublicKey: PublicKey): Promise<void> {
  let chainId: string;
  try {
    chainId = await chain.chainId();
  } catch (err) {
    throw new StartupError(
      `RPC_URL: cannot reach the NEAR RPC at ${redactUrl(config.rpcUrl)} (${err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)}). Check RPC_URL and that the node is running, then start the relayer again.`,
    );
  }
  if (/mainnet/i.test(chainId)) throw new StartupError("RPC_URL: this RPC node serves mainnet, which is refused in this submission. Point RPC_URL at a testnet or sandbox node.");
  if (config.network === "near:testnet" && chainId !== "testnet") {
    throw new StartupError(`RPC_URL: NETWORK is near:testnet but this RPC node serves chain "${chainId}". Point RPC_URL at a testnet node, or set NETWORK=near:sandbox for a local sandbox.`);
  }
  if (config.network === "near:sandbox" && chainId === "testnet") {
    throw new StartupError("NETWORK: is near:sandbox but RPC_URL serves testnet. Set NETWORK=near:testnet, or point RPC_URL at your sandbox.");
  }

  let key: Awaited<ReturnType<RelayChain["accessKey"]>>;
  try {
    key = await chain.accessKey(config.relayer, relayerPublicKey);
  } catch (err) {
    throw new StartupError(`RPC_URL: could not read the relayer's access key (${err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)}). Check the RPC node, then start the relayer again.`);
  }
  if (key === null) {
    throw new StartupError(
      `RELAYER_KEY: its public key ${relayerPublicKey} is not an access key of ${config.relayer} on ${config.network}. Use the secret key from that account's credentials file, or fix RELAYER_ACCOUNT.`,
    );
  }
  if (key.permission.kind !== "full_access") {
    throw new StartupError("RELAYER_KEY: must be a full-access key of RELAYER_ACCOUNT. A function-call key cannot sign the transaction that carries a delegate. Add a full-access key used only by this service.");
  }
}

/** Builds the relayer from its config, runs the startup checks and starts listening. */
export async function startRelayer(config: RelayerConfig, opts: StartRelayerOptions = {}): Promise<RunningRelayer> {
  const log = opts.logger ?? silentLogger;
  let relayerPublicKey: PublicKey;
  try {
    relayerPublicKey = publicKeyOfSecret(config.relayerKey);
  } catch {
    throw new StartupError("RELAYER_KEY: is not a valid NEAR ed25519 secret key. Copy the private_key field of the relayer account's credentials file.");
  }
  const chain =
    opts.chain ??
    new NearRelayChain({ rpcUrl: config.rpcUrl, network: config.network, relayer: config.relayer, relayerKey: config.relayerKey, readTimeoutMs: config.readTimeoutMs, sendTimeoutMs: config.sendTimeoutMs });

  await checkRelayerAccount(config, chain, relayerPublicKey);

  const balance = new BalanceWatch({ chain, account: config.relayer, lowYocto: config.lowBalanceYocto, logger: log });
  const first = await balance.refresh();
  if (first.error) log.warn("starting without a known balance; /health will show it once the RPC answers", { relayer: config.relayer });

  const gasLedger = opts.gasLedger !== undefined ? opts.gasLedger : config.gasLedgerPath ? new FileGasLedger(config.gasLedgerPath) : null;
  if (!gasLedger) log.warn("the daily gas count is kept in memory and starts from zero on every restart; set GAS_LEDGER_PATH to keep it");
  const app = createRelayerApp(config, { chain, logger: log, gasLedger, balance });

  // A port that is taken (EADDRINUSE) rejects here, so the caller can stop cleanly.
  const server = await new Promise<Server>((resolve, reject) => {
    const srv = serve({ fetch: app.fetch, port: opts.port ?? config.port, hostname: config.host }, () => {
      srv.off("error", reject);
      resolve(srv as Server);
    });
    srv.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${config.host.includes(":") ? `[${config.host}]` : config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${port}`;
  log.info("relayer listening", { url, balanceNear: first.near, config: redactedConfig(config) });

  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= new Promise<void>((resolve) => {
      log.info("shutting down");
      server.close(() => {
        log.info("stopped");
        resolve();
      });
      server.closeIdleConnections?.();
      // A relay in flight keeps its connection until the network answers; after that deadline it is cut.
      setTimeout(() => server.closeAllConnections?.(), config.sendTimeoutMs + 2_000).unref();
    }));

  return { app, url, port, stop };
}
