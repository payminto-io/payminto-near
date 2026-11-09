import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  fallback,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { localAnvil, mockStablecoinAbi, networkFor } from "@payminto/protocol";
import { REPO_ROOT } from "./config.ts";

const run = promisify(execFile);

export function freePort(): Promise<number> {
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

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/**
 * Whether nothing listens on the port. Without a host it probes both 127.0.0.1 and 0.0.0.0: macOS lets a wildcard
 * bind succeed next to a loopback-only listener (a Docker port forward, say), so one probe alone misses it.
 */
export async function portIsFree(port: number, host?: string): Promise<boolean> {
  if (host) return canBind(port, host);
  return (await canBind(port, "127.0.0.1")) && (await canBind(port, "0.0.0.0"));
}

export type Rpc = {
  rpcUrl: string;
  chain: Chain;
  pub: PublicClient<Transport, Chain>;
  wallet(key: Hex): WalletClient<Transport, Chain, Account>;
};

export function rpcFor(chainId: number, rpcUrl: string): Rpc {
  const base = chainId === 31337 ? localAnvil : networkFor(chainId).chain;
  const chain = defineChain({ ...base, rpcUrls: { default: { http: [rpcUrl] } } });
  // Live chains: the given RPC first, then the network's other public RPCs. Public endpoints drop requests ("fetch
  // failed"), and one dropped read must not end a run that has already spent testnet funds.
  const urls = chainId === 31337 ? [rpcUrl] : [...new Set([rpcUrl, ...base.rpcUrls.default.http])];
  const transport = urls.length > 1 ? fallback(urls.map((u) => http(u, { retryCount: 3, timeout: 20_000 })), { retryCount: 2 }) : http(rpcUrl, { retryCount: 3, timeout: 20_000 });
  const pub = createPublicClient({ chain, transport, pollingInterval: chainId === 31337 ? 100 : 1_000 });
  return { rpcUrl, chain, pub, wallet: (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport }) };
}

export type AnvilProcess = { rpcUrl: string; port: number; stop(): Promise<void> };

/**
 * Starts a fresh anvil under a shell watchdog: if this process dies for any reason (even SIGKILL), the watchdog notices
 * within a second and stops anvil, so no orphan survives. Without `port`, anvil binds port 0 and reports the port it
 * got ("Listening on ..."), so two runs started at once can never share one anvil (a probe-then-bind port could be
 * taken by another run's anvil in between, and this run would then talk to that one).
 */
export async function startAnvil(opts: { port?: number; blockTime?: number } = {}): Promise<AnvilProcess> {
  const args = ["--port", String(opts.port ?? 0), ...(opts.blockTime ? ["--block-time", String(opts.blockTime)] : [])];
  const script = `anvil ${args.join(" ")} & A=$!; trap 'kill $A 2>/dev/null' EXIT INT TERM; while kill -0 ${process.pid} 2>/dev/null && kill -0 $A 2>/dev/null; do sleep 1; done`;
  const proc: ChildProcess = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  /** Resolves once the watchdog (and with it anvil) has exited, at most ~3 s. */
  const stop = async () => {
    if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000).unref())]);
  };
  let port: number;
  try {
    port = await listeningPort(proc, 15_000);
  } catch (err) {
    await stop();
    throw new Error(`anvil did not start${opts.port ? ` on port ${opts.port}` : ""} (is foundry installed? try: anvil --version): ${(err as Error).message}`);
  }
  const rpcUrl = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (proc.exitCode !== null || i > 150) {
        await stop();
        throw new Error(`anvil did not answer on port ${port}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { rpcUrl, port, stop };
}

/** The port from anvil's "Listening on 127.0.0.1:PORT" line; its later output is drained so the pipe never fills. */
export function listeningPort(proc: ChildProcess, timeoutMs: number): Promise<number> {
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

const DeployLock = join(REPO_ROOT, "contracts", "cache", "payminto-deploy-local.lock");

/**
 * One forge run at a time across processes: parallel runs would compile into the same out/ and cache/ and write the
 * same broadcast file. A lock older than two minutes is a crashed run's and is taken over.
 */
async function withDeployLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(DeployLock), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(DeployLock, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(DeployLock).mtimeMs > 120_000) rmSync(DeployLock, { force: true });
      } catch {
        // gone already: retry
      }
      if (i > 3_000) throw new Error(`timed out waiting for ${DeployLock}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(DeployLock, { force: true });
  }
}

/**
 * Deploys ClearingHub, MockStablecoin and the gateway contracts with `forge script script/DeployLocal.s.sol` (anvil
 * only). The script writes this run's own file under contracts/deployments/local/ (DEPLOY_LOCAL_OUT), never the shared
 * deployments/31337.json that other local sessions rely on; the result is copied into this run's directory.
 */
export async function forgeDeployLocal(rpcUrl: string, deployerKey: Hex, runDeploymentsDir: string): Promise<{ hub: Address; token: Address; blockNumber: number }> {
  const rel = `deployments/local/${process.pid}-${randomBytes(6).toString("hex")}.json`;
  const out = join(REPO_ROOT, "contracts", rel);
  let fresh: string;
  try {
    await withDeployLock(() =>
      run("forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--private-key", deployerKey], {
        cwd: join(REPO_ROOT, "contracts"),
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1", DEPLOY_LOCAL_OUT: rel },
      }),
    );
    fresh = readFileSync(out, "utf8");
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`forge DeployLocal failed: ${(e.stderr ?? e.message).split("\n").slice(-6).join("\n")}`);
  } finally {
    rmSync(out, { force: true });
  }
  mkdirSync(runDeploymentsDir, { recursive: true });
  writeFileSync(join(runDeploymentsDir, "31337.json"), fresh);
  const d = JSON.parse(fresh) as { clearingHub: string; token: string; blockNumber: number };
  return { hub: getAddress(d.clearingHub), token: getAddress(d.token), blockNumber: d.blockNumber };
}

export async function mintLocal(rpc: Rpc, minterKey: Hex, token: Address, to: Address, amount: bigint): Promise<void> {
  const hash = await rpc.wallet(minterKey).writeContract({ address: token, abi: mockStablecoinAbi, functionName: "mint", args: [to, amount] });
  const r = await rpc.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`mint reverted in ${hash}`);
}
