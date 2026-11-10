/**
 * `NearRelayChain` against a JSON-RPC stub on the loopback interface: the real near-kit code path that wraps a signed
 * delegate, signs the outer transaction and sends it, with no NEAR node and no network.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { publicKeyBytes, publicKeyToString } from "@payminto/chain";
import { base58 } from "@scure/base";
import { FunctionCallError, NearError, NetworkError } from "near-kit";
import { afterEach, describe, expect, it } from "vitest";
import { SubmitError } from "../src/chain.ts";
import { NearRelayChain, publicKeyOfSecret, relayFailureOf, submitErrorOf } from "../src/near-chain.ts";
import { HUB, OWNER, OWNER_KEY, bodyOf, bytesOf, revoke } from "./helpers.ts";

// A test key that belongs to no account anywhere.
const RELAYER_KEY = "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";
const RELAYER_PUBLIC = publicKeyOfSecret(RELAYER_KEY);
const BLOCK_HASH = "8sPRLUk5FXH3vdTdXV3tWrw7WkoFJEn5RFGtXNhrqgwN";
const HASH = "11111111111111111111111111111111";

type Call = { method: string; params: Record<string, unknown> };
type Answer = { result: unknown } | { error: unknown } | "hang" | "drop" | { http: number };

const block = (height: number) => ({
  author: "node0",
  header: {
    height,
    prev_height: height - 1,
    epoch_id: HASH,
    next_epoch_id: HASH,
    hash: BLOCK_HASH,
    prev_hash: HASH,
    prev_state_root: HASH,
    chunk_receipts_root: HASH,
    chunk_headers_root: HASH,
    chunk_tx_root: HASH,
    outcome_root: HASH,
    chunks_included: 1,
    challenges_root: HASH,
    timestamp: 1_800_000_000_000_000_000,
    timestamp_nanosec: "1800000000000000000",
    random_value: HASH,
    validator_proposals: [],
    chunk_mask: [true],
    gas_price: "100000000",
    block_ordinal: height,
    total_supply: "1000000000000000000000000000000000",
    challenges_result: [],
    last_final_block: HASH,
    last_ds_final_block: HASH,
    next_bp_hash: HASH,
    block_merkle_root: HASH,
    approvals: [null],
    signature: "ed25519:" + "1".repeat(88),
    latest_protocol_version: 80,
  },
  chunks: [],
});

const outcome = (id: string, executor: string, status: unknown, receiptIds: string[] = []) => ({
  id,
  block_hash: BLOCK_HASH,
  proof: [],
  outcome: { logs: [], receipt_ids: receiptIds, gas_burnt: 512_494_085_495, tokens_burnt: "51249408549500000000", executor_id: executor, status },
});

const OK = { SuccessValue: "" };
const TX = "6TkSFuQg6CukeeApGAoDJCyFYUwrfe5t85gshcxn5iAL";
const DELEGATE_RECEIPT = "6ep3QgGkgGHzdfGCgyr1EmPZTwZ4LNpZDi8bgWxGqJv1";
const HUB_RECEIPT = "Db87gmQtofqHyVNHtHzUKYw6vCsHrTU7izu9xf6h61sY";
const HUB_CHILD = "9vTnJGcLWAhp1fDGvJzQzq1JgXjMkmFQYS9mUtG5mYVQ";
const REFUND_1 = "BGVh4i8N7aZT7cpKx55rfeVGTzeCapHNYVfWhJNBzJDX";
const REFUND_2 = "66Rj3iVBF8UD55Rtp232v9bK7Mtb3CmSwkwHkE3WGeN4";

/**
 * What nearcore answers to `send_tx` with `wait_until: FINAL` for a relayed delegate. The receipt chain is the one a
 * near-sandbox 2.14.0 node returned for a relayed `revoke_budget` on 2026-11-10: the transaction, the delegate receipt
 * on the sender's account, the function call on the hub, and two gas refunds to the relayer. `hubChild` adds a receipt
 * the hub itself created, as `payout` does.
 */
const sendResult = (relayer: string, o: { top?: unknown; delegate?: unknown; hub?: unknown; hubChild?: unknown } = {}) => ({
  final_execution_status: "FINAL",
  status: o.top ?? OK,
  transaction: {
    signer_id: relayer,
    public_key: RELAYER_PUBLIC,
    nonce: 8,
    receiver_id: OWNER,
    actions: [{ Delegate: { delegate_action: { sender_id: OWNER, receiver_id: HUB, actions: [], nonce: 5, max_block_height: 1120, public_key: OWNER_KEY.publicKey }, signature: "ed25519:" + "1".repeat(88) } }],
    signature: "ed25519:" + "1".repeat(88),
    hash: TX,
  },
  transaction_outcome: outcome(TX, relayer, { SuccessReceiptId: DELEGATE_RECEIPT }, [DELEGATE_RECEIPT]),
  receipts_outcome: [
    outcome(DELEGATE_RECEIPT, OWNER, o.delegate ?? OK, o.delegate ? [REFUND_2] : [HUB_RECEIPT, REFUND_2]),
    ...(o.delegate ? [] : [outcome(HUB_RECEIPT, HUB, o.hub ?? OK, o.hubChild ? [HUB_CHILD, REFUND_1] : [REFUND_1])]),
    ...(o.hubChild ? [outcome(HUB_CHILD, "usdc.fakes.testnet", o.hubChild)] : []),
    outcome(REFUND_1, relayer, OK),
    outcome(REFUND_2, relayer, OK),
  ],
});

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** A JSON-RPC server on 127.0.0.1 that records every call. `answer` overrides the defaults per call. */
async function stubRpc(relayer: string, answer: (call: Call) => Answer | undefined = () => undefined): Promise<{ url: string; calls: Call[]; sends: () => Call[] }> {
  const calls: Call[] = [];
  const defaults = (call: Call): Answer => {
    if (call.method === "status") return { result: { chain_id: "testnet" } };
    if (call.method === "block") return { result: block(call.params.finality === "optimistic" ? 1003 : 1000) };
    if (call.method === "query" && call.params.request_type === "view_access_key") {
      if (call.params.account_id === relayer) return { result: { nonce: 7, permission: "FullAccess", block_height: 1000, block_hash: BLOCK_HASH } };
      return { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_ACCESS_KEY", info: { public_key: call.params.public_key } } } };
    }
    if (call.method === "query" && call.params.request_type === "view_account") {
      return { result: { amount: "2500000000000000000000000", locked: "0", code_hash: HASH, storage_usage: 182, storage_paid_at: 0, block_height: 1000, block_hash: BLOCK_HASH } };
    }
    if (call.method === "send_tx") return { result: sendResult(relayer) };
    return { error: { name: "REQUEST_VALIDATION_ERROR", code: -32601, message: `stub has no answer for ${call.method}` } };
  };
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c: Buffer) => (text += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(text) as { id: unknown; method: string; params: Record<string, unknown> };
      const call = { method: body.method, params: body.params };
      calls.push(call);
      const a = answer(call) ?? defaults(call);
      if (a === "hang") return;
      if (a === "drop") return void req.socket.destroy();
      if ("http" in a) {
        res.writeHead(a.http).end("upstream error");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...a }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, sends: () => calls.filter((c) => c.method === "send_tx") };
}

let n = 0;
/** A relayer account per test: near-kit caches nonces per account and key for the whole process. */
const freshRelayer = (): string => `relayer${++n}.payminto.testnet`;
const chainFor = (url: string, relayer: string, sendTimeoutMs = 5_000): NearRelayChain =>
  new NearRelayChain({ rpcUrl: url, network: "near:testnet", relayer, relayerKey: RELAYER_KEY, readTimeoutMs: 2_000, sendTimeoutMs });

const failure = async (p: Promise<unknown>): Promise<SubmitError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SubmitError);
    return err as SubmitError;
  }
  throw new Error("expected the submission to fail");
};

/** Reads the Borsh `SignedTransaction` the relayer sent. */
function parseOuterTx(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const str = (): string => {
    const len = view.getUint32(o, true);
    o += 4;
    const s = new TextDecoder().decode(bytes.subarray(o, o + len));
    o += len;
    return s;
  };
  const signer = str();
  const keyType = bytes[o++];
  const publicKey = publicKeyToString(bytes.subarray(o, o + 32));
  o += 32;
  const nonce = view.getBigUint64(o, true);
  o += 8;
  const receiver = str();
  const blockHash = base58.encode(bytes.subarray(o, o + 32));
  o += 32;
  const actionCount = view.getUint32(o, true);
  o += 4;
  const actionIndex = bytes[o++];
  const body = bytes.subarray(0, bytes.length - 65);
  return { signer, keyType, publicKey, nonce, receiver, blockHash, actionCount, actionIndex, actionPayload: body.subarray(o), body, signature: bytes.subarray(bytes.length - 64), signatureType: bytes[bytes.length - 65] };
}

describe("NearRelayChain.submitDelegate", () => {
  it("wraps the exact signed delegate in one transaction signed by the relayer, sends it once and waits for FINAL", async () => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer);
    const delegate = bytesOf(bodyOf(revoke()));
    const txHash = await chainFor(rpc.url, relayer).submitDelegate(delegate);

    expect(rpc.sends()).toHaveLength(1);
    const params = rpc.sends()[0]!.params as { signed_tx_base64: string; wait_until: string };
    expect(params.wait_until).toBe("FINAL");
    const tx = parseOuterTx(new Uint8Array(Buffer.from(params.signed_tx_base64, "base64")));
    // The relayer signs and pays; the receiver is the owner, whose account runs the delegate.
    expect(tx).toMatchObject({ signer: relayer, keyType: 0, publicKey: RELAYER_PUBLIC, nonce: 8n, receiver: OWNER, blockHash: BLOCK_HASH, actionCount: 1, actionIndex: 8, signatureType: 0 });
    // The one action is Action::Delegate followed by the bytes the owner signed, unchanged.
    expect(Buffer.from(tx.actionPayload).equals(Buffer.from(delegate))).toBe(true);
    expect(ed25519.verify(tx.signature, sha256(tx.body), publicKeyBytes(RELAYER_PUBLIC))).toBe(true);
    expect(txHash).toBe(base58.encode(sha256(tx.body)));
  });

  it("never resends when the answer to the send is lost: outcome unknown, with the tx hash", async () => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer, (c) => (c.method === "send_tx" ? "drop" : undefined));
    const err = await failure(chainFor(rpc.url, relayer).submitDelegate(bytesOf(bodyOf(revoke()))));
    expect(err.failure).toBe("unknown");
    expect(err.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    await new Promise((r) => setTimeout(r, 300));
    expect(rpc.sends()).toHaveLength(1);
  });

  it("never resends when the send times out or the RPC answers 503", async () => {
    const hanging = freshRelayer();
    const rpc1 = await stubRpc(hanging, (c) => (c.method === "send_tx" ? "hang" : undefined));
    const timedOut = await failure(chainFor(rpc1.url, hanging, 400).submitDelegate(bytesOf(bodyOf(revoke()))));
    expect(timedOut.failure).toBe("unknown");
    expect(timedOut.txHash).toBeDefined();
    expect(rpc1.sends()).toHaveLength(1);

    const failing = freshRelayer();
    const rpc2 = await stubRpc(failing, (c) => (c.method === "send_tx" ? { http: 503 } : undefined));
    expect((await failure(chainFor(rpc2.url, failing).submitDelegate(bytesOf(bodyOf(revoke()))))).failure).toBe("unknown");
    await new Promise((r) => setTimeout(r, 300));
    expect(rpc2.sends()).toHaveLength(1);
  });

  it("reports not_sent when the RPC is down before anything is signed", async () => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer, (c) => (c.method === "query" ? { http: 503 } : undefined));
    const err = await failure(chainFor(rpc.url, relayer).submitDelegate(bytesOf(bodyOf(revoke()))));
    expect(err.failure).toBe("not_sent");
    expect(rpc.sends()).toHaveLength(0);
  });

  it("reports rejected when the network refuses the relayer's transaction before it runs", async () => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer, (c) =>
      c.method === "send_tx"
        ? { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "INVALID_TRANSACTION", info: {} }, data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { signer_id: relayer, balance: "1", cost: "2" } } } } } }
        : undefined,
    );
    const err = await failure(chainFor(rpc.url, relayer).submitDelegate(bytesOf(bodyOf(revoke()))));
    expect(err.failure).toBe("rejected");
    expect(rpc.sends()).toHaveLength(1);
  });

  const panic = (text: string) => ({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${text}` } } } } });
  const submitWith = async (result: (relayer: string) => unknown): Promise<SubmitError> => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer, (c) => (c.method === "send_tx" ? { result: result(relayer) } : undefined));
    return failure(chainFor(rpc.url, relayer).submitDelegate(bytesOf(bodyOf(revoke()))));
  };

  it("reads the hub's refusal from the hub's receipt, although the network reports the transaction as a success", async () => {
    // The shape a real node returned: top-level SuccessValue, delegate receipt SuccessValue, hub receipt Failure.
    const known = await submitWith((relayer) => sendResult(relayer, { hub: panic("NOT_OWNER") }));
    expect(known).toMatchObject({ failure: "call_failed", message: "NOT_OWNER" });
    expect(known.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

    // A panic the hub's error list does not know yet (the contract is still changing) keeps its text.
    const unknown = await submitWith((relayer) => sendResult(relayer, { hub: panic("AGENT_PAUSED: new rule") }));
    expect(unknown.failure).toBe("call_failed");
    expect(unknown.message).toBe("Smart contract panicked: AGENT_PAUSED: new rule");

    // The same refusal when a node does report it at the top level.
    expect(await submitWith((relayer) => sendResult(relayer, { top: panic("ALREADY_REVOKED"), hub: panic("ALREADY_REVOKED") }))).toMatchObject({ failure: "call_failed", message: "ALREADY_REVOKED" });
  });

  it.each([
    ["DelegateActionInvalidNonce", { delegate_nonce: 5, ak_nonce: 9 }, "nonce_used"],
    ["DelegateActionExpired", null, "expired"],
    ["DelegateActionAccessKeyError", { RequiresFullAccess: null }, "key_error"],
    ["DelegateActionInvalidSignature", null, "key_error"],
  ] as const)("maps a %s failure of the delegate receipt, reported at the top level or not", async (kind, info, expected) => {
    const fail = { Failure: { ActionError: { index: 0, kind: { [kind]: info } } } };
    const quiet = await submitWith((relayer) => sendResult(relayer, { delegate: fail }));
    expect(quiet.failure).toBe(expected);
    expect(quiet.txHash).toBeDefined();
    const loud = await submitWith((relayer) => sendResult(relayer, { top: fail, delegate: fail }));
    expect(loud.failure).toBe(expected);
    expect(loud.txHash).toBeDefined();
  });

  it("maps any other failure of the hub call to call_failed", async () => {
    const gone = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: HUB } } } } };
    const err = await submitWith((relayer) => sendResult(relayer, { hub: gone }));
    expect(err.failure).toBe("call_failed");
    expect(err.message).toContain("AccountDoesNotExist");
  });

  it("does not read a failure deeper in the hub's own receipts as a failure of the relayed call", async () => {
    // payout: the hub ran, then one token transfer it started failed. The hub's callback handles that.
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer, (c) => (c.method === "send_tx" ? { result: sendResult(relayer, { hubChild: panic("The account is not registered") }) } : undefined));
    await expect(chainFor(rpc.url, relayer).submitDelegate(bytesOf(bodyOf(revoke())))).resolves.toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("fails closed on an outcome whose receipts do not link up: any failed receipt counts", () => {
    const odd = { status: OK, transaction_outcome: { id: TX, outcome: { receipt_ids: ["missing"] } }, receipts_outcome: [{ id: "x", outcome: { executor_id: "elsewhere", status: panic("BOOM") } }] };
    expect(relayFailureOf(odd, HUB)).toContain("BOOM");
    expect(relayFailureOf({ status: panic("TOP"), receipts_outcome: [] }, HUB)).toContain("TOP");
  });

  it("sends nothing for bytes near-kit cannot wrap unchanged", async () => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer);
    const err = await failure(chainFor(rpc.url, relayer).submitDelegate(Uint8Array.of(1, 2, 3)));
    expect(err.failure).toBe("not_sent");
    expect(rpc.calls).toHaveLength(0);
  });

  it("sends submissions one after another, each with the next nonce", async () => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer);
    const chain = chainFor(rpc.url, relayer);
    await Promise.all([chain.submitDelegate(bytesOf(bodyOf(revoke({ nonce: 5n })))), chain.submitDelegate(bytesOf(bodyOf(revoke({ nonce: 6n }))))]);
    const nonces = rpc.sends().map((c) => parseOuterTx(new Uint8Array(Buffer.from((c.params as { signed_tx_base64: string }).signed_tx_base64, "base64"))).nonce);
    expect(nonces).toEqual([8n, 9n]);
  });
});

describe("NearRelayChain reads", () => {
  it("reads the chain id, the newest height and a balance", async () => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer);
    const chain = chainFor(rpc.url, relayer);
    expect(await chain.chainId()).toBe("testnet");
    expect(await chain.blockHeight()).toBe(1003n);
    expect(await chain.balance(relayer)).toBe(2_500_000_000_000_000_000_000_000n);
    expect(rpc.calls.find((c) => c.method === "block")!.params).toEqual({ finality: "optimistic" });
  });

  it("reads a full-access key and a function-call key", async () => {
    const relayer = freshRelayer();
    const rpc = await stubRpc(relayer, (c) =>
      c.method === "query" && c.params.account_id === OWNER
        ? { result: { nonce: 41, permission: { FunctionCall: { receiver_id: HUB, method_names: ["revoke_budget"], allowance: "250000000000000000000000" } }, block_height: 1000, block_hash: BLOCK_HASH } }
        : undefined,
    );
    const chain = chainFor(rpc.url, relayer);
    expect(await chain.accessKey(relayer, RELAYER_PUBLIC)).toEqual({ nonce: 7n, permission: { kind: "full_access" } });
    expect(await chain.accessKey(OWNER, OWNER_KEY.publicKey)).toEqual({ nonce: 41n, permission: { kind: "function_call", receiverId: HUB, methodNames: ["revoke_budget"] } });
  });

  it("returns null for a key or an account that does not exist, in every form nodes answer with", async () => {
    const relayer = freshRelayer();
    // Current nodes: a top-level error with cause UNKNOWN_ACCESS_KEY (the stub's default for other accounts).
    const modern = await stubRpc(relayer);
    expect(await chainFor(modern.url, relayer).accessKey(OWNER, OWNER_KEY.publicKey)).toBeNull();
    // Older nodes: a result that carries an error string.
    const legacy = await stubRpc(relayer, (c) =>
      c.method === "query" ? { result: { error: `access key ${OWNER_KEY.publicKey} does not exist while viewing`, logs: [], block_height: 1000, block_hash: BLOCK_HASH } } : undefined,
    );
    expect(await chainFor(legacy.url, relayer).accessKey(OWNER, OWNER_KEY.publicKey)).toBeNull();
    const noAccount = await stubRpc(relayer, (c) =>
      c.method === "query" ? { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: "ghost.testnet" } } } } : undefined,
    );
    expect(await chainFor(noAccount.url, relayer).accessKey("ghost.testnet", OWNER_KEY.publicKey)).toBeNull();
  });

  it("reports a gas key as a kind it does not sponsor, and fails on an RPC outage instead of guessing", async () => {
    const relayer = freshRelayer();
    const gas = await stubRpc(relayer, (c) =>
      c.method === "query" ? { result: { nonce: 1, permission: { GasKeyFullAccess: { balance: "1", num_nonces: 4 } }, block_height: 1000, block_hash: BLOCK_HASH } } : undefined,
    );
    expect(await chainFor(gas.url, relayer).accessKey(OWNER, OWNER_KEY.publicKey)).toEqual({ nonce: 1n, permission: { kind: "other", name: "GasKeyFullAccess" } });
    const down = await stubRpc(relayer, (c) => (c.method === "query" ? { http: 502 } : undefined));
    await expect(chainFor(down.url, relayer).accessKey(OWNER, OWNER_KEY.publicKey)).rejects.toThrow();
  });
});

describe("submitErrorOf", () => {
  const sent = { sent: true, txHash: "T1" };

  it("once the bytes were sent, anything it does not recognise may still land", () => {
    expect(submitErrorOf(new Error("???"), sent)).toMatchObject({ failure: "unknown", txHash: "T1" });
    expect(submitErrorOf("a string", sent).failure).toBe("unknown");
    expect(submitErrorOf(new NetworkError("Network request failed: socket hang up"), sent).failure).toBe("unknown");
    expect(submitErrorOf(new NearError("no answer in time", "TIMEOUT_ERROR"), sent).failure).toBe("unknown");
  });

  it("before anything was sent, every failure is not_sent", () => {
    const before = { sent: false };
    expect(submitErrorOf(new Error("???"), before).failure).toBe("not_sent");
    expect(submitErrorOf(new NetworkError("Network request failed: fetch failed"), before).failure).toBe("not_sent");
    expect(submitErrorOf(new NearError("Access key does not exist", "ACCESS_KEY_NOT_FOUND"), before).failure).toBe("not_sent");
  });

  it("tells a refusal before the transaction ran from a failure after it ran", () => {
    // near-kit's InvalidNonceError and InvalidTransactionError are NearErrors with these codes and the failure as data.
    const invalidTx = (message: string, details: unknown) => new NearError(message, "INVALID_TRANSACTION", details);
    expect(submitErrorOf(new NearError("Invalid transaction nonce", "INVALID_NONCE"), sent)).toMatchObject({ failure: "rejected", txHash: "T1" });
    expect(submitErrorOf(invalidTx("Server error", { NotEnoughBalance: { balance: "1", cost: "2" } }), sent).failure).toBe("rejected");
    expect(submitErrorOf(invalidTx("Transaction execution failed", { ActionError: { kind: { DelegateActionInvalidNonce: {} } } }), sent).failure).toBe("nonce_used");
    expect(submitErrorOf(invalidTx("DelegateActionExpired", { ActionError: { kind: { DelegateActionExpired: null } } }), sent).failure).toBe("expired");
    expect(submitErrorOf(new FunctionCallError("hub.testnet", "revoke_budget", "Smart contract panicked: NOT_OWNER"), sent)).toMatchObject({ failure: "call_failed", message: "NOT_OWNER", txHash: "T1" });
    const same = new SubmitError("expired", "x");
    expect(submitErrorOf(same, sent)).toBe(same);
  });
});
