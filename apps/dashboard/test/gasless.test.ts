import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NearReader, keypairFromSeed, revokeBudgetTx, type WalletTx } from "@payminto/protocol";
import { auditSignedDelegate, bytesToBase64, delegateChainProblem, hubRefusalText, loadAddons, revokedOnHub, sendGasless, type GaslessStep } from "@/lib/gasless";
import { MockPanic, demoHeight, mockRpcFetch } from "@/lib/mock/rpc";
import type { ReaderSource } from "@/lib/near-reader";
import { RelayerClient, type RelayerFetch, type RelayerInfo } from "@/lib/relayer";
import { FlowError, isWalletRejection, setWalletDriver } from "@/lib/wallet";
import { FakeWallet } from "./fake-wallet";

const HUB = "hub.payminto.testnet";
const OWNER = "alice.testnet";
const BUDGET = "ab".repeat(32);
const INFO: RelayerInfo = { relayer: "relayer.payminto.testnet", hub: HUB, network: "near:testnet", methods: ["revoke_budget", "reclaim"], maxGasTgas: 300 };
const NODE = { hub: HUB, network: "near:testnet" as const };
const TX = revokeBudgetTx(HUB, BUDGET);
/** A test key made from a fixed seed. It is on no network. */
const KEY = keypairFromSeed(new Uint8Array(32).fill(7));
const OTHER_KEY = keypairFromSeed(new Uint8Array(32).fill(8));

// A chain in memory: the hub's view of one Budget and one access key, served through the same JSON-RPC as the mock.
let hubBudget: { revoked_at: string | null; escrow: string } | null;
let keyNonce: number;
let source: ReaderSource;
let wallet: FakeWallet;
let relayAnswer: { status: number; body: unknown } | Error;
let info: RelayerInfo;
let relayed: string[];
let steps: GaslessStep[];

/** Signs as a wallet would: the delegate is built and signed with the add-on, with a nonce and height the wallet chose. */
async function sign(tx: WalletTx, over: { nonce?: bigint; maxBlockHeight?: bigint; key?: typeof KEY; sender?: string } = {}): Promise<string> {
  const { gasless } = await loadAddons();
  const key = over.key ?? KEY;
  const delegate = { senderId: over.sender ?? OWNER, receiverId: tx.receiverId, actions: gasless.fromWalletActions(tx.actions), nonce: over.nonce ?? BigInt(keyNonce + 1), maxBlockHeight: over.maxBlockHeight ?? BigInt(demoHeight() + 120), publicKey: key.publicKey };
  return bytesToBase64(gasless.encodeSignedDelegate(gasless.signDelegate(delegate, key.secretKey)));
}

function client(): RelayerClient {
  const fetch: RelayerFetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === "GET" && path === "/info") return { status: 200, text: async () => JSON.stringify(info) };
    if (init.method === "POST" && path === "/relay") {
      relayed.push((JSON.parse(init.body ?? "{}") as { signedDelegate: string }).signedDelegate);
      if (relayAnswer instanceof Error) throw relayAnswer;
      return { status: relayAnswer.status, text: async () => JSON.stringify(relayAnswer instanceof Error ? {} : relayAnswer.body) };
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  return new RelayerClient("https://relayer.example.test", { fetch });
}

const send = () =>
  sendGasless({ tx: TX, owner: OWNER, node: NODE, client: client(), source, effect: revokedOnHub(HUB, BUDGET), what: "revoke", progress: (s) => steps.push(s), confirm: { tries: 2, intervalMs: 1 } });
const ok = (txHash = "RelayedTx1") => ({ status: 200, body: { txHash, sender: OWNER, receiver: HUB, methods: ["revoke_budget"] } });
const refused = (status: number, error: Record<string, unknown>) => ({ status, body: { error } });

beforeEach(() => {
  hubBudget = { revoked_at: null, escrow: "5000000" };
  keyNonce = 100;
  info = INFO;
  relayed = [];
  steps = [];
  relayAnswer = ok();
  const rpc = mockRpcFetch(
    {
      hub: HUB,
      view: (method) => {
        if (method === "budget") return hubBudget;
        throw new MockPanic(`MethodNotFound ${method}`);
      },
      txFinal: () => false,
      accessKey: (account, publicKey) => (account === OWNER && publicKey === KEY.publicKey ? { nonce: keyNonce } : null),
    },
    0,
  );
  source = { reader: new NearReader({ rpcUrl: "https://rpc.example.test", hub: HUB, fetch: rpc }), demo: false, fetch: rpc };
  wallet = new FakeWallet({ account: OWNER });
  wallet.delegateImpl = (delegates) => Promise.all(delegates.map((tx) => sign(tx)));
  setWalletDriver(wallet);
});
afterEach(() => setWalletDriver(null));

describe("a gasless revoke, end to end with a fake wallet, relayer and chain", () => {
  it("signs the reviewed call, posts exactly what the wallet signed, and is final only once the hub shows the revoke", async () => {
    relayAnswer = ok("RelayedTx1");
    const run = send();
    // The relayer's answer alone is not proof: the hub records the revoke, and only then is it final.
    hubBudget!.revoked_at = "1794300000000";
    expect(await run).toEqual({ hash: "RelayedTx1", status: "final" });
    expect(wallet.delegated).toEqual([[TX]]);
    expect(wallet.sent).toEqual([]);
    expect(relayed).toHaveLength(1);
    const { gasless } = await loadAddons();
    expect(auditSignedDelegate(gasless, relayed[0]!, { owner: OWNER, tx: TX }).problems).toEqual([]);
    expect(steps.map((s) => s.title)).toEqual(["Checking the relayer", "Approve in your wallet", "Checking the signature against NEAR", "The relayer is sending it", "Confirming on the hub"]);
    expect(steps.at(-1)!.hash).toBe("RelayedTx1");
  });

  it("does not call it revoked when the relayer says done and the hub does not show it", async () => {
    expect(await send()).toEqual({ hash: "RelayedTx1", status: "pending" });
  });

  it("reports a call the hub refused as failed, with the hub's reason and the transaction, never as revoked", async () => {
    relayAnswer = refused(422, { code: "CALL_FAILED", message: "the hub refused the call: Smart contract panicked: NOT_OWNER", txHash: "FailedTx" });
    const r = await send();
    expect(r).toMatchObject({ hash: "FailedTx", status: "failed" });
    expect(r.status === "failed" && r.error).toContain("does not own this Budget");
    expect(r.status === "failed" && r.error).toContain("Nothing changed on the hub");
  });

  it("reads the hub when the outcome is unknown: unknown while the hub is unchanged, final once it shows the revoke", async () => {
    relayAnswer = refused(502, { code: "RPC_FAILED", message: "sent, result not known", outcomeUnknown: true, txHash: "MaybeTx" });
    expect(await send()).toEqual({ hash: "MaybeTx", status: "pending", unknown: true });
    hubBudget!.revoked_at = "1794300000000";
    keyNonce = 100;
    expect(await send()).toEqual({ hash: "MaybeTx", status: "final" });
  });

  it("treats a repeat the relayer already submitted as that first transaction", async () => {
    relayAnswer = refused(409, { code: "NONCE_USED", message: "already submitted", txHash: "FirstTx" });
    hubBudget!.revoked_at = "1794300000000";
    expect(await send()).toEqual({ hash: "FirstTx", status: "final" });
  });

  it("says in plain words when the relayer refuses before sending, and when it sent nothing", async () => {
    relayAnswer = refused(403, { code: "NOT_SPONSORED", message: "raw" });
    const notSponsored = await send().catch((e: unknown) => e);
    expect(notSponsored).toBeInstanceOf(FlowError);
    expect((notSponsored as Error).message).toContain("Nothing was sent");
    relayAnswer = refused(502, { code: "RPC_FAILED", message: "raw", outcomeUnknown: false });
    expect(((await send().catch((e: unknown) => e)) as Error).message).toContain("sent nothing");
    relayAnswer = refused(429, { code: "RATE_LIMITED", message: "raw", retryAfterSec: 3600 });
    expect(((await send().catch((e: unknown) => e)) as Error).message).toContain("about 60 minutes");
  });
});

describe("refused before anything reaches the relayer", () => {
  it("does not ask the wallet when the relayer sponsors another hub", async () => {
    info = { ...INFO, hub: "hub.someone-else.testnet" };
    const e = (await send().catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("Nothing was signed or sent");
    expect(wallet.delegated).toEqual([]);
    expect(relayed).toEqual([]);
  });

  it("explains a wallet that cannot sign delegate actions, and names wallets that can", async () => {
    wallet.support = { wallet: "Fake Wallet", supported: false, capable: ["Fake Wallet", "Other Wallet"] };
    const e = (await send().catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(FlowError);
    expect(e.message).toContain("Fake Wallet cannot sign");
    expect(e.message).toContain("Connect Other Wallet");
    expect(e.message).toContain("needs a little NEAR for gas");
    expect(wallet.delegated).toEqual([]);
    expect(relayed).toEqual([]);
  });

  it("passes a cancel in the wallet through as a cancel", async () => {
    wallet.delegateImpl = () => Promise.reject(new Error("User rejected the request"));
    expect(isWalletRejection(await send().catch((x: unknown) => x))).toBe(true);
    expect(relayed).toEqual([]);
  });

  it("refuses a signature over another call than the one reviewed", async () => {
    wallet.delegateImpl = () => Promise.all([sign(revokeBudgetTx(HUB, "cd".repeat(32)))]);
    const e = (await send().catch((x: unknown) => x)) as Error;
    expect(e.message).toContain("something other than the call you reviewed");
    expect(e.message).toContain("arguments differ");
    expect(relayed).toEqual([]);
  });

  it("refuses a key that is not on the account, a used nonce and an expired signature, each read from the chain", async () => {
    wallet.delegateImpl = () => Promise.all([sign(TX, { key: OTHER_KEY })]);
    expect(((await send().catch((x: unknown) => x)) as Error).message).toContain("key that is not on alice.testnet");
    wallet.delegateImpl = () => Promise.all([sign(TX, { nonce: BigInt(keyNonce) })]);
    expect(((await send().catch((x: unknown) => x)) as Error).message).toContain("nonce NEAR has already seen");
    wallet.delegateImpl = () => Promise.all([sign(TX, { maxBlockHeight: 1n })]);
    expect(((await send().catch((x: unknown) => x)) as Error).message).toContain("already expired");
    expect(relayed).toEqual([]);
  });
});

describe("the pure checks", () => {
  it("auditSignedDelegate names each difference and never throws on garbage", async () => {
    const { gasless } = await loadAddons();
    expect(auditSignedDelegate(gasless, "bm90IGEgZGVsZWdhdGU=", { owner: OWNER, tx: TX })).toEqual({ signed: null, problems: ["it is not a signed delegate action"] });
    const fromStranger = auditSignedDelegate(gasless, await sign(TX, { sender: "mallory.testnet" }), { owner: OWNER, tx: TX });
    expect(fromStranger.problems).toEqual(["it is from mallory.testnet, not alice.testnet"]);
  });

  it("delegateChainProblem refuses a limited key that may not make the call", async () => {
    const { gasless } = await loadAddons();
    const signed = gasless.decodeSignedDelegate(Uint8Array.from(atob(await sign(TX)), (c) => c.charCodeAt(0)));
    const reader = (permission: unknown) => ({ accessKey: async () => ({ nonce: 100n, permission }), finalHeight: async () => 10n });
    expect(await delegateChainProblem(reader("FullAccess"), signed, HUB)).toBeNull();
    expect(await delegateChainProblem(reader({ FunctionCall: { receiver_id: HUB, method_names: ["revoke_budget"] } }), signed, HUB)).toBeNull();
    expect(await delegateChainProblem(reader({ FunctionCall: { receiver_id: HUB, method_names: ["reclaim"] } }), signed, HUB)).toContain("limited key");
    expect(await delegateChainProblem(reader({ FunctionCall: { receiver_id: "other.testnet", method_names: [] } }), signed, HUB)).toContain("limited key");
  });

  it("hubRefusalText words the hub's codes and never calls a refusal done", () => {
    expect(hubRefusalText("revoke", "Smart contract panicked: ALREADY_REVOKED")).toContain("already revoked on the hub");
    expect(hubRefusalText("reclaim", "Smart contract panicked: TOO_EARLY")).toContain("grace period has not ended");
    expect(hubRefusalText("revoke", "something unexpected")).toContain("did not say why");
  });
});
