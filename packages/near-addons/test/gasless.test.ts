import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { publicKeyBytes, publicKeyToString, type PublicKey } from "@payminto/chain";
import { DelegateAction as NkDelegateAction, decodeSignedDelegateAction, DELEGATE_ACTION_PREFIX as NK_PREFIX, serializeDelegateAction } from "near-kit";
import { describe, expect, it } from "vitest";
import {
  checkRelayPolicy,
  decodeSignedDelegate,
  DEFAULT_RELAY_METHODS,
  DELEGATE_ACTION_PREFIX,
  delegateHash,
  delegateParams,
  delegateSigningPayload,
  encodeDelegateAction,
  encodeDelegateTxAction,
  encodeSignedDelegate,
  payoutDelegate,
  reclaimDelegate,
  relayRequestBody,
  revokeBudgetDelegate,
  signDelegate,
  verifySignedDelegate,
  type DelegateAction,
  type RelayPolicy,
  type SignedDelegate,
} from "../src/gasless/delegate.ts";
import { ViewRpc } from "../src/rpc.ts";
import { fakeFetch } from "./helpers.ts";

const SEED = new Uint8Array(32).fill(9);
const PK = publicKeyToString(ed25519.getPublicKey(SEED));
const HUB = "hub.payminto.testnet";
const BUDGET = "ab".repeat(32);
const revoke = (over: Partial<DelegateAction> = {}): DelegateAction => ({
  ...revokeBudgetDelegate({ owner: "alice.testnet", hub: HUB, budgetId: BUDGET, publicKey: PK, nonce: 5n, maxBlockHeight: 1_000n }),
  ...over,
});
const policy: RelayPolicy = { hub: HUB, methods: DEFAULT_RELAY_METHODS, maxGasPerAction: 300_000_000_000_000n, maxTtlBlocks: 600n };

/**
 * `DELEGATE_ACTION_HEX` from nearcore `core/primitives/src/action/delegate.rs` tests: Action::Delegate with sender
 * "aaa", receiver "bbb", one CreateAccount action, nonce 1, max_block_height 2, an empty ED25519 key and signature.
 */
const NEARCORE_DELEGATE_ACTION_HEX =
  "0803000000616161030000006262620100000000010000000000000002000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000";
const EMPTY_KEY = publicKeyToString(new Uint8Array(32)) as PublicKey;
const nearcoreVector: SignedDelegate = {
  delegateAction: { senderId: "aaa", receiverId: "bbb", actions: [{ type: "CreateAccount" }], nonce: 1n, maxBlockHeight: 2n, publicKey: EMPTY_KEY },
  signature: new Uint8Array(64),
};

describe("NEP-366 encoding vectors", () => {
  it("reproduces nearcore's hard-coded Action::Delegate bytes exactly", () => {
    expect(bytesToHex(encodeDelegateTxAction(nearcoreVector))).toBe(NEARCORE_DELEGATE_ACTION_HEX);
    expect(decodeSignedDelegate(hexToBytes(NEARCORE_DELEGATE_ACTION_HEX).subarray(1))).toEqual(nearcoreVector);
  });

  it("uses the NEP-461 tag 2^30 + 366 = 1073742190, the same as near-kit", () => {
    expect(DELEGATE_ACTION_PREFIX).toBe(1073742190);
    expect(NK_PREFIX).toBe(DELEGATE_ACTION_PREFIX);
    expect(bytesToHex(delegateSigningPayload(revoke()).subarray(0, 4))).toBe("6e010040");
  });

  it("pins the exact bytes of a revoke_budget delegate", () => {
    const hex = bytesToHex(encodeDelegateAction(revoke()));
    const args = bytesToHex(new TextEncoder().encode(`{"budget_id":"${BUDGET}"}`));
    expect(hex).toBe(
      [
        "0d000000" + bytesToHex(new TextEncoder().encode("alice.testnet")),
        "14000000" + bytesToHex(new TextEncoder().encode(HUB)),
        "01000000", // one action
        "02", // FunctionCall
        "0d000000" + bytesToHex(new TextEncoder().encode("revoke_budget")),
        "50000000" + args, // 80 bytes of JSON args
        "00e057eb481b0000", // gas 30 Tgas, u64 LE
        "00000000000000000000000000000000", // deposit 0, u128 LE
        "0500000000000000", // nonce
        "e803000000000000", // max_block_height 1000
        "00" + bytesToHex(publicKeyBytes(PK)),
      ].join(""),
    );
  });

  it("near-kit decodes our SignedDelegateAction to the same fields", () => {
    const s = signDelegate(revoke(), SEED);
    const { signedDelegate } = decodeSignedDelegateAction(encodeSignedDelegate(s)) as unknown as {
      signedDelegate: {
        delegateAction: { senderId: string; receiverId: string; nonce: bigint; maxBlockHeight: bigint; actions: Array<{ functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } }>; publicKey: { ed25519Key: { data: number[] } } };
        signature: { ed25519Signature: { data: number[] } };
      };
    };
    const d = signedDelegate.delegateAction;
    expect([d.senderId, d.receiverId, d.nonce, d.maxBlockHeight]).toEqual(["alice.testnet", HUB, 5n, 1000n]);
    const fc = d.actions[0]!.functionCall;
    expect([fc.methodName, new TextDecoder().decode(new Uint8Array(fc.args)), fc.gas, fc.deposit]).toEqual(["revoke_budget", `{"budget_id":"${BUDGET}"}`, 30_000_000_000_000n, 0n]);
    expect(Uint8Array.from(d.publicKey.ed25519Key.data)).toEqual(publicKeyBytes(PK));
    expect(Uint8Array.from(signedDelegate.signature.ed25519Signature.data)).toEqual(s.signature);
  });

  it("near-kit builds the same signing payload from the same fields", () => {
    const s = signDelegate(revoke(), SEED);
    const { signedDelegate } = decodeSignedDelegateAction(encodeSignedDelegate(s)) as unknown as { signedDelegate: { delegateAction: { actions: unknown[] } } };
    const theirs = serializeDelegateAction(
      new NkDelegateAction("alice.testnet", HUB, signedDelegate.delegateAction.actions as never, 5n, 1000n, { keyType: 0, data: publicKeyBytes(PK) } as never),
    );
    expect(bytesToHex(theirs)).toBe(bytesToHex(delegateSigningPayload(revoke())));
  });

  it("round-trips, and the relayer's Action::Delegate starts with index 8", () => {
    const s = signDelegate(revoke(), SEED);
    expect(decodeSignedDelegate(encodeSignedDelegate(s))).toEqual(s);
    expect(encodeDelegateTxAction(s)[0]).toBe(8);
    expect(Buffer.from(relayRequestBody(s).signedDelegate, "base64")).toEqual(Buffer.from(encodeSignedDelegate(s)));
  });

  it("rejects trailing bytes, unknown actions and other key types", () => {
    const bytes = encodeSignedDelegate(signDelegate(revoke(), SEED));
    expect(() => decodeSignedDelegate(Uint8Array.from([...bytes, 0]))).toThrow(/trailing/);
    const transfer = Uint8Array.from(bytes);
    transfer[4 + 13 + 4 + HUB.length + 4] = 3; // the first action's enum index -> Transfer
    expect(() => decodeSignedDelegate(transfer)).toThrow(/unsupported inner action 3/);
    const secp = Uint8Array.from(bytes);
    secp[bytes.length - 65] = 1; // the signature's key type -> SECP256K1
    expect(() => decodeSignedDelegate(secp)).toThrow(/key type 1/);
  });
});

describe("signing and verification", () => {
  it("signs sha256 of the tagged payload with the delegate's key", () => {
    const s = signDelegate(revoke(), SEED);
    expect(ed25519.verify(s.signature, delegateHash(revoke()), publicKeyBytes(PK))).toBe(true);
    expect(verifySignedDelegate(s)).toBe(true);
  });

  it("fails verification after any field changes", () => {
    const s = signDelegate(revoke(), SEED);
    for (const over of [{ nonce: 6n }, { maxBlockHeight: 1001n }, { receiverId: "evil.testnet" }, { senderId: "bob.testnet" }]) {
      expect(verifySignedDelegate({ ...s, delegateAction: { ...s.delegateAction, ...over } })).toBe(false);
    }
  });

  it("refuses to sign with a key other than the delegate's", () => {
    expect(() => signDelegate(revoke(), new Uint8Array(32).fill(1))).toThrow(/does not match/);
  });
});

describe("relayer policy: only signed, zero-deposit calls to our own hub", () => {
  const ok = (d: DelegateAction) => checkRelayPolicy(signDelegate(d, SEED), policy, 900n);

  it("accepts revoke, reclaim and payout", () => {
    expect(ok(revoke())).toEqual([]);
    expect(ok(reclaimDelegate({ owner: "alice.testnet", hub: HUB, budgetId: BUDGET, publicKey: PK, nonce: 5n, maxBlockHeight: 1_000n }))).toEqual([]);
    expect(ok(payoutDelegate({ owner: "alice.testnet", hub: HUB, accounts: ["alice.testnet"], publicKey: PK, nonce: 5n, maxBlockHeight: 1_000n }))).toEqual([]);
  });

  it("refuses other receivers, other methods, deposits, expiry, far-future heights and bad signatures", () => {
    expect(ok(revoke({ receiverId: "other.testnet" })).join()).toMatch(/not the hub/);
    const fund = revoke();
    fund.actions = [{ type: "FunctionCall", methodName: "fund_from_credit", args: new Uint8Array(), gas: 1n, deposit: 1n }];
    expect(ok(fund).join("; ")).toMatch(/fund_from_credit is not sponsored.*attaches 1 yoctoNEAR/);
    expect(checkRelayPolicy(signDelegate(revoke(), SEED), policy, 1_000n).join()).toMatch(/expired/);
    expect(ok(revoke({ maxBlockHeight: 10_000n })).join()).toMatch(/too far ahead/);
    const s = signDelegate(revoke(), SEED);
    expect(checkRelayPolicy({ ...s, signature: new Uint8Array(64) }, policy, 900n).join()).toMatch(/signature/);
    expect(ok({ ...revoke(), actions: [{ type: "CreateAccount" }] }).join()).toMatch(/CreateAccount is not sponsored/);
  });
});

describe("delegate parameters from read-only RPC", () => {
  it("uses the next nonce of the owner's key and a short validity window", async () => {
    const { fetch, calls } = fakeFetch([
      { method: "POST", url: "https://rpc.testnet.near.org", rpc: "view_access_key", status: 200, body: { jsonrpc: "2.0", id: "x", result: { nonce: 41, permission: "FullAccess", block_height: 500, block_hash: "x" } } },
      { method: "POST", url: "https://rpc.testnet.near.org", rpc: "block", status: 200, body: { jsonrpc: "2.0", id: "x", result: { header: { height: 777 } } } },
    ]);
    expect(await delegateParams(new ViewRpc("https://rpc.testnet.near.org", fetch), "alice.testnet", PK)).toEqual({ nonce: 42n, maxBlockHeight: 897n });
    expect(calls.map((c) => (c.body as { method: string }).method)).toEqual(["query", "block"]);
  });

  it("the reader exposes only reads; its private dispatcher allows only query and block", () => {
    expect(Object.getOwnPropertyNames(ViewRpc.prototype).sort()).toEqual(["accessKey", "constructor", "finalHeight", "view"]);
  });
});
