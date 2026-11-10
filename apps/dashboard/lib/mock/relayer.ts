/**
 * The demo relayer and the demo wallet's keys, for NEXT_PUBLIC_MOCK. The relayer answers `GET /info` and `POST /relay`
 * as the real service does (apps/relayer/README.md, "HTTP API"): it runs the add-on's own relay policy on what it
 * receives, applies the call to the in-memory hub with the owner as the caller, answers 200 only when the hub ran the
 * call, and 422 CALL_FAILED with the transaction when the hub refused it. No network, no real key: the keys are
 * derived from the account name.
 */
import { id32Bytes, keypairFromSeed, sha256Text, type AccountId, type Keypair, type Network, type WalletTx } from "@payminto/protocol";
import { base64ToBytes } from "../gasless";
import type { RelayerFetch } from "../relayer";
import { demo } from "./scenario";
import type { MockTxOutcome } from "./server";

export const DEMO_RELAYER_URL = "demo:relayer";
export const DEMO_RELAYER_ACCOUNT: AccountId = "relayer.payminto.testnet";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One full-access key per demo account, and the nonce the demo chain has seen for it. */
export class DemoKeys {
  readonly #keys = new Map<AccountId, { pair: Keypair; nonce: number }>();

  #entry(account: AccountId) {
    let k = this.#keys.get(account);
    if (!k) {
      // Derived from the name, so it is the same on every load and is plainly not a real key.
      k = { pair: keypairFromSeed(id32Bytes(sha256Text(`payminto demo wallet key, not a real key: ${account}`))), nonce: 219_400_000_000_000 };
      this.#keys.set(account, k);
    }
    return k;
  }
  pair(account: AccountId): Keypair {
    return this.#entry(account).pair;
  }
  /** As `view_access_key`: the nonce when the key belongs to the account, null otherwise. */
  nonce(account: AccountId, publicKey: string): { nonce: number } | null {
    const k = this.#entry(account);
    return k.pair.publicKey === publicKey ? { nonce: k.nonce } : null;
  }
  use(account: AccountId, nonce: bigint): void {
    this.#entry(account).nonce = Number(nonce);
  }
}

export type MockRelayerDeps = {
  hub: AccountId;
  network: Network;
  keys: DemoKeys;
  /** The demo chain's current height, for the expiry check. */
  height(): number;
  /** Applies the call to the demo hub with `signer` as the caller. */
  run(tx: WalletTx, signer: AccountId): MockTxOutcome;
  /** Files the relayer's transaction on the demo chain: final at `finalAtMs`, or failed with the hub's panic. */
  record(hash: string, o: { finalAtMs: number; failure: string | null }): void;
  /** A NEAR-shaped transaction hash. */
  hash(): string;
};

const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { error: { code, message, ...extra } });

export function mockRelayerFetch(d: MockRelayerDeps): RelayerFetch {
  return async (url, init) => {
    await pause(300);
    if (demo("relayer-down")) throw new TypeError("Failed to fetch");
    const { gasless } = await import("@payminto/near-addons");
    const path = url.slice(DEMO_RELAYER_URL.length);

    if (init.method === "GET" && path === "/info") {
      return json(200, {
        relayer: DEMO_RELAYER_ACCOUNT,
        hub: demo("relayer-wrong-hub") ? "hub.someone-else.testnet" : d.hub,
        network: d.network.replace(/^near:/, ""),
        methods: [...gasless.DEFAULT_RELAY_METHODS],
        maxGasTgas: 300,
      });
    }

    if (init.method === "POST" && path === "/relay") {
      // The real relayer holds the connection until its transaction is final: a few seconds, at most a minute.
      await pause(demo("relayer-slow") ? 9000 : 1800);
      if (demo("relayer-not-sponsored")) return refuse(403, "NOT_SPONSORED", "this relayer does not sponsor the call");
      if (demo("relayer-rate-limited")) return refuse(429, "RATE_LIMITED", "the daily gas budget is spent; revoke with your own gas or wait", { retryAfterSec: 3 * 3600 });
      if (demo("relayer-call-failed")) return refuse(422, "CALL_FAILED", "the hub refused the call: Smart contract panicked: NOT_OWNER", { txHash: d.hash() });
      if (demo("relayer-unknown")) return refuse(502, "RPC_FAILED", "the transaction was sent and its result is not known", { outcomeUnknown: true, txHash: d.hash() });
      let signed: ReturnType<typeof gasless.decodeSignedDelegate>;
      try {
        signed = gasless.decodeSignedDelegate(base64ToBytes(String((JSON.parse(init.body ?? "{}") as { signedDelegate?: unknown }).signedDelegate ?? "")));
      } catch {
        return refuse(400, "MALFORMED", "signedDelegate is not a base64 Borsh SignedDelegateAction");
      }
      const action = signed.delegateAction;
      const height = BigInt(d.height());
      if (!gasless.verifySignedDelegate(signed)) return refuse(403, "BAD_SIGNATURE", "the signature does not verify");
      if (action.maxBlockHeight <= height) return refuse(409, "EXPIRED", "max_block_height has passed");
      const problems = gasless.checkRelayPolicy(signed, { hub: d.hub, methods: gasless.DEFAULT_RELAY_METHODS, maxGasPerAction: 300_000_000_000_000n, maxTtlBlocks: 600n }, height);
      if (problems.length > 0) return refuse(403, "NOT_SPONSORED", problems.join("; "));
      const key = d.keys.nonce(action.senderId, action.publicKey);
      if (!key) return refuse(403, "BAD_SIGNATURE", "the key is not on the sender's account");
      if (action.nonce <= BigInt(key.nonce)) return refuse(409, "NONCE_USED", "the nonce was already used");
      d.keys.use(action.senderId, action.nonce);

      const calls = action.actions.filter((a) => a.type === "FunctionCall");
      const tx: WalletTx = {
        receiverId: action.receiverId,
        actions: calls.map((a) => ({ type: "FunctionCall", params: { methodName: a.methodName, args: JSON.parse(new TextDecoder().decode(a.args)) as Record<string, unknown>, gas: a.gas.toString(), deposit: a.deposit.toString() } })),
      };
      const outcome = d.run(tx, action.senderId);
      const hash = d.hash();
      d.record(hash, { finalAtMs: Date.now(), failure: outcome.ok ? null : outcome.error.replace(/^Smart contract panicked: /, "") });
      if (!outcome.ok) return refuse(422, "CALL_FAILED", `the hub refused the call: ${outcome.error}`, { txHash: hash });
      return json(200, { txHash: hash, sender: action.senderId, receiver: action.receiverId, methods: calls.map((a) => a.methodName) });
    }
    return refuse(404, "NOT_FOUND", "no such route");
  };
}
