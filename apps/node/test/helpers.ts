import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clearingHubAbi, clearingHubBytecode, localAnvil, mockStablecoinAbi, mockStablecoinBytecode } from "@payminto/protocol";
import { DEFAULT_RATE_LIMIT, type Config } from "../src/config.ts";

/** Anvil default dev keys: public, local only. */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const satisfies readonly Hex[];

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export type Anvil = {
  rpcUrl: string;
  chain: Chain;
  pub: PublicClient<Transport, Chain>;
  wallet(key: Hex): WalletClient<Transport, Chain, Account>;
  deploy(abi: Abi, bytecode: Hex): Promise<Address>;
  stop(): void;
};

/** The port from anvil's "Listening on 127.0.0.1:PORT" line; later output is drained so the pipe never fills. */
function anvilPort(proc: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (err: Error | null, port?: number) => {
      clearTimeout(timer);
      proc.stdout!.off("data", onData);
      proc.off("exit", onExit);
      proc.stdout!.on("data", () => {});
      if (err) reject(err);
      else resolve(port!);
    };
    const onData = (d: Buffer) => {
      buf = (buf + d.toString("utf8")).slice(-4096);
      const m = /Listening on \S*?:(\d+)/.exec(buf);
      if (m) done(null, Number(m[1]));
    };
    const onExit = () => done(new Error("anvil exited before listening"));
    const timer = setTimeout(() => done(new Error(`no "Listening on" line within ${timeoutMs} ms`)), timeoutMs);
    proc.stdout!.on("data", onData);
    proc.once("exit", onExit);
  });
}

/**
 * Boots a fresh anvil on a random free port. `args` adds flags (the fork suite passes --fork-url), `chain` is the
 * chain definition the clients use (a HashKey Chain definition for forks).
 */
export async function startAnvil(opts: { args?: string[]; chain?: Chain; startupMs?: number } = {}): Promise<Anvil> {
  // Port 0: anvil binds a port the OS picks and reports it, so parallel test files can never end up on one anvil
  // (a probed free port could be taken by another file's anvil before this one binds it).
  const proc: ChildProcess = spawn("anvil", ["--port", "0", ...(opts.args ?? [])], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await anvilPort(proc, opts.startupMs ?? 15_000).catch((err: Error) => {
    proc.kill();
    throw new Error(`anvil did not start: ${err.message}`);
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = defineChain({ ...(opts.chain ?? localAnvil), rpcUrls: { default: { http: [rpcUrl] } } });
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain, transport, pollingInterval: 100 });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (i > (opts.startupMs ?? 15_000) / 100) {
        proc.kill();
        throw new Error("anvil did not start");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport });
  const deployer = wallet(ANVIL_KEYS[0]);
  return {
    rpcUrl,
    chain,
    pub,
    wallet,
    async deploy(abi, bytecode) {
      const hash = await deployer.deployContract({ abi, bytecode });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      return getAddress(rcpt.contractAddress!);
    },
    stop() {
      proc.kill();
    },
  };
}

export async function deployClearing(anvil: Anvil): Promise<{ hub: Address; token: Address }> {
  const hub = await anvil.deploy(clearingHubAbi as Abi, clearingHubBytecode);
  const token = await anvil.deploy(mockStablecoinAbi as Abi, mockStablecoinBytecode);
  return { hub, token };
}

export async function mint(anvil: Anvil, token: Address, to: Address, amount: bigint): Promise<void> {
  const w = anvil.wallet(ANVIL_KEYS[0]);
  const hash = await w.writeContract({ address: token, abi: mockStablecoinAbi, functionName: "mint", args: [to, amount] });
  await anvil.pub.waitForTransactionReceipt({ hash });
}

/** Fresh temp directory per test file; never DB_PATH. */
export function tempDir(prefix = "payminto-node-"): { dir: string; dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, "clearing.test.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(over: Partial<Config> & Pick<Config, "rpcUrl" | "hub" | "token" | "dbPath">): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    chainId: 31337,
    operatorKey: ANVIL_KEYS[9],
    adminToken: "test-admin-token-123",
    settleIntervalSec: 0,
    settleMinCalls: 1,
    publicUrl: "http://127.0.0.1:0",
    hsp: { mode: "local", verifyingContract: over.hub, cosignTimeoutSec: 10 },
    corsOrigins: ["http://localhost:3000"],
    logLevel: "error",
    fundsRefreshSec: 30,
    deployBlock: 0n,
    rpcFallbackUrls: [],
    rateLimit: DEFAULT_RATE_LIMIT,
    trustProxyHops: 0,
    denials: { dedupWindowSec: 60, maxRows: 100_000 },
    eventsMaxRows: 200_000,
    // Cheap password hashing and generous auth limits keep suites fast; the auth suite tightens them where it tests them.
    auth: { scryptLogN: 12, rateLimitPerMin: 10_000, setupPerMin: 10_000, emailPerHour: 10_000, searchRps: 1_000 },
    ...over,
  };
}
