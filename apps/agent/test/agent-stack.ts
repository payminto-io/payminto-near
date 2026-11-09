/**
 * The demo stack (own anvil, forge deploy, in-process node on a disposable *.demo.db in a temp dir, the demo's paid
 * providers) plus what the agents need on top of it: a buyer agent and a seller agent, each with its own key, tokens
 * and gasless mandate, and the seller's market brief skill registered on the node and served. Nothing here touches
 * a shared database or a real chain.
 */
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toHex, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { mockStablecoinAbi } from "@payminto/protocol";
import { AgentClient, OwnerClient } from "@payminto/sdk";
import { assertDisposableTarget } from "@payminto/node";
import { loadDemoConfig, startStack, type Stack } from "@payminto/demo";
import type { ModelClient } from "@payminto/models";
import { discoverInputs, marketBriefApp, registerSeller } from "../src/seller.ts";
import { listen, type Listening } from "../src/service.ts";

const USDC = 1_000_000n;
export const SELLER_PRICE = 30_000n;

/** Anvil's public dev mnemonic, accounts past the ones the demo uses (0-17). Local chain only. */
const devKey = (i: number): Hex => toHex(mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i }).getHdKey().privateKey!);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function freeBlock(): Promise<number> {
  for (;;) {
    const base = 20_000 + Math.floor(Math.random() * 30_000);
    const ok = await Promise.all(
      [0, 1, 2, 3].map(
        (i) =>
          new Promise<boolean>((r) => {
            const s = createServer();
            s.once("error", () => r(false));
            s.listen(base + i, "127.0.0.1", () => s.close(() => r(true)));
          }),
      ),
    );
    if (ok.every(Boolean)) return base;
  }
}

export type AgentStack = {
  stack: Stack;
  dataDir: string;
  buyer: { key: Hex; address: Address; mandateId: Hex; storePath: string };
  seller: { key: Hex; address: Address; mandateId: Hex; storePath: string; client: AgentClient; providerId: string; url: string };
  /** The env the buyer's wallet MCP server runs with (what `payminto-agent run` passes through). */
  buyerEnv: Record<string, string>;
  sellerEnv: Record<string, string>;
  stop(): Promise<void>;
};

export async function startAgentStack(o: { sellerModel: ModelClient }): Promise<AgentStack> {
  const dataDir = mkdtempSync(join(tmpdir(), "payminto-agent-"));
  const cfg = loadDemoConfig({
    DEMO_CALLS: "20",
    DEMO_NODE_PORT: "0",
    DEMO_PROVIDER_BASE_PORT: String(await freeBlock()),
    DEMO_OFFLINE: "1",
    DEMO_DATA_DIR: dataDir,
    DEMO_HSP_COSIGN_TIMEOUT_SEC: "10",
  });
  const stack = await startStack(cfg);
  const closers: Array<() => Promise<void> | void> = [];
  const stop = async () => {
    for (const c of closers.reverse()) await Promise.resolve(c()).catch(() => {});
    await stack.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    const { rpc, hub, token, nodeUrl } = stack;
    const operator = stack.addresses.operator;
    const keys = { buyer: devKey(18), seller: devKey(19) };
    const addr = { buyer: privateKeyToAccount(keys.buyer).address, seller: privateKeyToAccount(keys.seller).address };
    const stores = { buyer: join(stack.runDir, "agent-buyer.receipts.demo.db"), seller: join(stack.runDir, "agent-seller.receipts.demo.db") };
    for (const p of Object.values(stores)) assertDisposableTarget(p);

    for (const who of ["buyer", "seller"] as const) {
      const hash = await rpc.wallet(cfg.keys.deployer!).writeContract({ address: token, abi: mockStablecoinAbi, functionName: "mint", args: [addr[who], 10n * USDC] });
      await rpc.pub.waitForTransactionReceipt({ hash });
    }

    // The seller's skill: registered like the demo providers, then served on the port it registered.
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const provider = await registerSeller(stack.admin, { payee: addr.seller, price: SELLER_PRICE, resource: `${url}/v1/brief` });

    // Mandates: the buyer may pay only the seller; the seller may pay only its suppliers. Both onboard gasless.
    const owner = new OwnerClient({ nodeUrl, chainId: cfg.chainId, hub, account: privateKeyToAccount(cfg.keys.owner), publicClient: rpc.pub, fetch: stack.session.fetch });
    const open = async (who: "buyer" | "seller", payees: Address[], perCallCap: bigint, label: string) => {
      const cap = 2n * USDC;
      const policy = { perCallCap: perCallCap.toString(), dailyCap: cap.toString(), maxCallsPerMinute: 600, purpose: label };
      const m = await owner.createMandate({ agent: addr[who], token, totalCap: cap, validForSeconds: 3600, payees, policy });
      const signer = new AgentClient({ chainId: cfg.chainId, hub, nodeUrl, account: privateKeyToAccount(keys[who]), mandateId: m.mandateId });
      const permit = await signer.signPermit({ token, value: cap, publicClient: rpc.pub });
      signer.close();
      const res = (await owner.submit({ ...m, policy, payees, label, permit })) as { status: string };
      if (res.status !== "open") throw new Error(`${label} mandate is ${res.status}`);
      return m.mandateId;
    };
    const buyerMandate = await open("buyer", [addr.seller], 50_000n, "Buyer agent: research briefs");
    const sellerMandate = await open("seller", [stack.addresses.market, stack.addresses.risk], cfg.prices.risk, "Market brief seller: buys quotes and scans");

    const client = new AgentClient({ chainId: cfg.chainId, hub, nodeUrl, account: privateKeyToAccount(keys.seller), mandateId: sellerMandate, storePath: stores.seller, trustedNode: operator, autoCosign: true, cosignIntervalMs: 250 });
    closers.push(() => client.close());
    const app = marketBriefApp({ nodeUrl, provider, price: SELLER_PRICE, buyer: client, inputs: () => discoverInputs(nodeUrl, provider.id), model: o.sellerModel });
    const served: Listening = await listen(app, port);
    closers.push(() => served.close());

    const walletEnv = (who: "buyer" | "seller", mandateId: Hex): Record<string, string> => ({
      NODE_URL: nodeUrl,
      CHAIN_ID: String(cfg.chainId),
      RPC_URL: rpc.rpcUrl,
      HUB_ADDRESS: hub,
      TRUSTED_NODE: operator,
      AGENT_KEY: keys[who],
      MANDATE_ID: mandateId,
      RECEIPT_STORE_PATH: stores[who],
    });
    return {
      stack,
      dataDir,
      buyer: { key: keys.buyer, address: addr.buyer, mandateId: buyerMandate, storePath: stores.buyer },
      seller: { key: keys.seller, address: addr.seller, mandateId: sellerMandate, storePath: stores.seller, client, providerId: provider.id, url: `${url}/v1/brief` },
      buyerEnv: walletEnv("buyer", buyerMandate),
      sellerEnv: walletEnv("seller", sellerMandate),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** A co-signer for a debtor whose wallet process has exited: same key, same receipt store, so it signs only what it paid. */
export function cosigner(s: AgentStack, who: "buyer"): AgentClient {
  const a = s[who];
  const c = new AgentClient({ chainId: s.stack.cfg.chainId, hub: s.stack.hub, nodeUrl: s.stack.nodeUrl, account: privateKeyToAccount(a.key), mandateId: a.mandateId, storePath: a.storePath, trustedNode: s.stack.addresses.operator });
  c.startCosignLoop(250);
  return c;
}
