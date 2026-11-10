import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { FakeRelayChain } from "../src/fake.ts";
import { createLogger } from "../src/logger.ts";
import { publicKeyOfSecret } from "../src/near-chain.ts";
import { checkRelayerAccount, startRelayer, StartupError } from "../src/server.ts";
import { OWNER, OWNER_KEY, bodyOf, revoke } from "./helpers.ts";

// A test key that belongs to no account anywhere.
const KEY = "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";
const RELAYER = "relayer.payminto.testnet";
const HUB = "hub.payminto.testnet";
const config = (over: Record<string, string> = {}) => loadConfig({ RELAYER_ACCOUNT: RELAYER, RELAYER_KEY: KEY, HUB_ACCOUNT: HUB, NETWORK: "near:testnet", PORT: "0", ...over });
const PUBLIC = publicKeyOfSecret(KEY);

const chainWithRelayer = (): FakeRelayChain => {
  const chain = new FakeRelayChain().addKey(RELAYER, PUBLIC, 10n).setBalance(RELAYER, 3n * 10n ** 24n);
  chain.chainIdValue = "testnet";
  return chain;
};

const startupMessage = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StartupError);
    return (err as Error).message;
  }
  throw new Error("expected startup to fail");
};

describe("startup checks", () => {
  it("passes for a full-access key on the relayer account on the configured network", async () => {
    await expect(checkRelayerAccount(config(), chainWithRelayer(), PUBLIC)).resolves.toBeUndefined();
  });

  it("refuses an RPC node that serves mainnet, whatever the configuration says", async () => {
    const chain = chainWithRelayer();
    chain.chainIdValue = "mainnet";
    expect(await startupMessage(checkRelayerAccount(config(), chain, PUBLIC))).toContain("RPC_URL: this RPC node serves mainnet");
    expect(await startupMessage(checkRelayerAccount(config({ NETWORK: "near:sandbox" }), chain, PUBLIC))).toContain("serves mainnet");
  });

  it("refuses a network that does not match the RPC node", async () => {
    const chain = chainWithRelayer();
    chain.chainIdValue = "localnet";
    expect(await startupMessage(checkRelayerAccount(config(), chain, PUBLIC))).toContain('NETWORK is near:testnet but this RPC node serves chain "localnet"');
    chain.chainIdValue = "testnet";
    expect(await startupMessage(checkRelayerAccount(config({ NETWORK: "near:sandbox" }), chain, PUBLIC))).toContain("NETWORK: is near:sandbox but RPC_URL serves testnet");
  });

  it("says so when the RPC cannot be reached", async () => {
    const chain = chainWithRelayer();
    chain.readsFail = true;
    const message = await startupMessage(checkRelayerAccount(config(), chain, PUBLIC));
    expect(message).toContain("RPC_URL: cannot reach the NEAR RPC at https://rpc.testnet.near.org");
    expect(message).toContain("Check RPC_URL");
  });

  it("refuses a key that is not on the relayer account, without printing the secret", async () => {
    const chain = new FakeRelayChain();
    chain.chainIdValue = "testnet";
    const message = await startupMessage(checkRelayerAccount(config(), chain, PUBLIC));
    expect(message).toContain(`RELAYER_KEY: its public key ${PUBLIC} is not an access key of ${RELAYER}`);
    expect(message).not.toContain(KEY.slice(8));
  });

  it("refuses a function-call key: it cannot sign the transaction that carries a delegate", async () => {
    const chain = chainWithRelayer().addKey(RELAYER, PUBLIC, 10n, { kind: "function_call", receiverId: HUB, methodNames: [] });
    expect(await startupMessage(checkRelayerAccount(config(), chain, PUBLIC))).toContain("RELAYER_KEY: must be a full-access key");
  });
});

describe("startRelayer over real HTTP", () => {
  it("serves /info, /health and /relay on a real socket, and stops cleanly", async () => {
    const chain = chainWithRelayer().addKey(OWNER, OWNER_KEY.publicKey, 4n);
    const lines: string[] = [];
    const relayer = await startRelayer(config(), { chain, logger: createLogger({ sink: (l) => lines.push(l) }), gasLedger: null });
    try {
      expect(relayer.port).toBeGreaterThan(0);
      const info = await fetch(`${relayer.url}/info`);
      expect(await info.json()).toEqual({ relayer: RELAYER, hub: HUB, network: "near:testnet", methods: ["revoke_budget", "reclaim", "payout"], maxGasTgas: 300 });

      const health = (await (await fetch(`${relayer.url}/health`)).json()) as { ok: boolean; balance: { near: string; low: boolean } };
      expect(health).toMatchObject({ ok: true, balance: { near: "3.0000", low: false } });

      const res = await fetch(`${relayer.url}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyOf(revoke())) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ sender: OWNER, receiver: HUB, methods: ["revoke_budget"] });

      // A body over the cap is cut off by the server, not buffered.
      const big = await fetch(`${relayer.url}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedDelegate: "A".repeat(100_000) }) });
      expect(big.status).toBe(413);
    } finally {
      await relayer.stop();
    }
    await expect(fetch(`${relayer.url}/info`)).rejects.toThrow();
    const all = lines.join("\n");
    expect(all).toContain("relayer listening");
    expect(all).not.toContain(KEY.slice(8));
  });

  it("warns at startup when the balance is low, and still starts", async () => {
    const chain = chainWithRelayer().setBalance(RELAYER, 10n ** 23n);
    const lines: string[] = [];
    const relayer = await startRelayer(config(), { chain, logger: createLogger({ sink: (l) => lines.push(l) }), gasLedger: null });
    await relayer.stop();
    const warning = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "relayer balance is low; top it up or relays will start to fail");
    expect(warning).toMatchObject({ level: "warn", relayer: RELAYER, balanceNear: "0.1000", warnBelowNear: "0.5000" });
  });

  it("does not start when a check fails", async () => {
    const chain = chainWithRelayer();
    chain.chainIdValue = "mainnet";
    await expect(startRelayer(config(), { chain })).rejects.toBeInstanceOf(StartupError);
  });
});
