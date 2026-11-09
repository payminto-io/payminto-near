import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildNetTransferMandate,
  CAPABILITIES,
  clearingHubAbi,
  hspPaymentId,
  hspTypedData,
  requiredCapabilitiesHash,
} from "@payminto/protocol";
import { CoordinatorHspAdapter } from "../src/hsp/coordinator.ts";
import { LOCAL_REQUIRED_CAPABILITIES, LocalHspAdapter, decodeAddressPayload, hspReceiptTypes, observeSettlement, verifyLocalReceipt, type LocalHspReceipt } from "../src/hsp/local.ts";
import { ANVIL_KEYS } from "./helpers.ts";

const PAYER = privateKeyToAccount(ANVIL_KEYS[2]);
const ADAPTER = privateKeyToAccount(ANVIL_KEYS[9]);
const IMPOSTOR = privateKeyToAccount(ANVIL_KEYS[8]);
const RECIPIENT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const HUB = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TOKEN = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const BATCH = keccak256(toBytes("batch-7"));
const TX = keccak256(toBytes("tx-7"));

const body = (required: readonly string[] = LOCAL_REQUIRED_CAPABILITIES) =>
  buildNetTransferMandate({ payer: PAYER.address, recipient: RECIPIENT, token: TOKEN, amount: 350_000n, chainId: 31337, batchId: BATCH, deadline: 1_900_000_000n, requiredCapabilities: required });

type Script = {
  register?: number;
  observe202?: number;
  statuses?: string[];
  chains?: unknown;
  chainsStatus?: number;
  pinned?: Address;
  chainName?: string;
  required?: string[];
};
const REGISTRY = [
  { name: "hashkey", chainId: 177, verifyingContract: "0x00000000000000000000000000000000000000AA", stablecoin: { symbol: "USDC.e" }, confirmations: 12 },
  { name: "hashkey-testnet", chainId: "133", verifyingContract: HUB, adapterAddress: ADAPTER.address, confirmations: 1 },
];
async function ready(script: Script = {}) {
  const f = fakeCoordinator(script);
  await f.adapter.init(133);
  f.seen.length = 0;
  return f;
}
function fakeCoordinator(script: Script) {
  const seen: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = [];
  let observeCalls = 0;
  let getCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    const text = c.req.method === "POST" ? await c.req.raw.clone().text() : "";
    seen.push({ method: c.req.method, path: c.req.path, auth: c.req.header("authorization"), body: text ? JSON.parse(text) : null });
    await next();
  });
  app.post("/payments", (c) => (script.register && script.register >= 300 ? c.json({ error: "x" }, script.register as 500) : c.json({ paymentId: "pay_1", status: "PROPOSED" }, 201)));
  app.post("/payments/:id/observe", (c) => (++observeCalls <= (script.observe202 ?? 0) ? c.json({ status: "pending" }, 202) : c.json({ ok: true })));
  app.get("/chains", (c) => c.json(script.chains ?? REGISTRY, (script.chainsStatus ?? 200) as 200));
  app.get("/payments/:id", (c) => {
    const s = script.statuses ?? ["SETTLED"];
    return c.json({ status: s[Math.min(getCalls++, s.length - 1)] });
  });
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
  return {
    seen,
    adapter: new CoordinatorHspAdapter({
      url: "https://coordinator.example",
      apiKey: "hsp-test-key",
      chainName: script.chainName,
      verifyingContract: script.pinned,
      requiredCapabilities: script.required,
      fetch: fetchFn,
      backoffMs: [1, 1, 1],
      sleep: async () => {},
    }),
  };
}

describe("coordinator HSP adapter", () => {
  it("registers, observes through 202s, and polls until SETTLED", async () => {
    const { adapter, seen } = await ready({ observe202: 2, statuses: ["ATTEMPTED", "SETTLED"], chainName: "configured-name" });
    expect(adapter.chainName).toBe("hashkey-testnet"); // the registry wins over the fallback name
    const b = body([]);
    const out = await adapter.settle({ paymentId: hspPaymentId(31337, HUB, b), body: b, signerProof: "0x1234", txHash: TX, batchId: BATCH });
    expect(out).toMatchObject({ status: "SETTLED", coordinatorId: "pay_1", coordinatorStatus: "SETTLED" });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /payments",
      "POST /payments/pay_1/observe",
      "POST /payments/pay_1/observe",
      "POST /payments/pay_1/observe",
      "GET /payments/pay_1",
      "GET /payments/pay_1",
    ]);
    expect(seen.every((s) => s.auth === "Bearer hsp-test-key")).toBe(true);
    expect(seen[0]!.body).toEqual({
      chain: "hashkey-testnet",
      mandate: {
        body: { ...b, amount: "350000", chainId: "31337", deadline: "1900000000" },
        signerProof: "0x1234",
        requiredCapabilities: [],
      },
      attestations: [],
    });
    expect(seen[1]!.body).toEqual({ txHash: TX });
  });

  it("resumes an earlier registration instead of registering twice", async () => {
    const { adapter, seen } = await ready({});
    const b = body([]);
    const out = await adapter.settle({ paymentId: hspPaymentId(31337, HUB, b), body: b, signerProof: "0x12", txHash: TX, batchId: BATCH, coordinatorId: "pay_1" });
    expect(out.status).toBe("SETTLED");
    expect(seen.some((s) => s.path === "/payments")).toBe(false);
  });

  it("reports retryable failures and terminal statuses, and never submits without a co-signature", async () => {
    const b = body([]);
    const input = { paymentId: hspPaymentId(31337, HUB, b), body: b, signerProof: "0x12" as Hex, txHash: TX, batchId: BATCH };
    expect(await (await ready({ register: 503 })).adapter.settle(input)).toMatchObject({ status: "FAILED", retry: true });
    expect(await (await ready({ register: 400 })).adapter.settle(input)).toMatchObject({ status: "FAILED", retry: false });
    expect(await (await ready({ statuses: ["DISPUTED"] })).adapter.settle(input)).toMatchObject({ status: "FAILED", coordinatorStatus: "DISPUTED" });
    expect(await (await ready({ observe202: 99 })).adapter.settle(input)).toMatchObject({ status: "SUBMITTED", retry: true });
    expect(await (await ready({ statuses: ["ATTEMPTED"] })).adapter.settle(input)).toMatchObject({ status: "SUBMITTED", retry: true });
    // Never registers before the chain registry was read.
    expect(await fakeCoordinator({}).adapter.settle(input)).toMatchObject({ status: "FAILED", retry: true });
    const { adapter, seen } = await ready({});
    expect(await adapter.settle({ ...input, signerProof: null })).toEqual({ status: "UNSIGNED" });
    expect(seen).toHaveLength(0);
  });
});

describe("coordinator chain registry (GET /chains)", () => {
  it("resolves the registry name and verifyingContract by chain id, and sends the real required capabilities", async () => {
    const required = [CAPABILITIES.settlementVerified, CAPABILITIES.nettingBatch];
    const { adapter, seen } = fakeCoordinator({ required });
    expect(await adapter.init(133)).toEqual({ chainName: "hashkey-testnet", verifyingContract: HUB, source: "registry" });
    expect(adapter.verifyingContract).toBe(HUB);
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /chains"]);
    const b = body(required);
    await adapter.settle({ paymentId: hspPaymentId(133, HUB, b), body: b, signerProof: "0x12", txHash: TX, batchId: BATCH });
    const reg = seen.find((x) => x.path === "/payments")!.body as { chain: string; mandate: { requiredCapabilities: string[] } };
    expect(reg.chain).toBe("hashkey-testnet");
    expect(reg.mandate.requiredCapabilities).toEqual(required);
  });

  it("accepts a matching pin and refuses to start on a mismatch", async () => {
    await expect(fakeCoordinator({ pinned: HUB }).adapter.init(133)).resolves.toMatchObject({ verifyingContract: HUB });
    await expect(fakeCoordinator({ pinned: TOKEN }).adapter.init(133)).rejects.toThrow(/differs from the Coordinator registry/);
  });

  it("falls back to HSP_CHAIN_NAME plus the pin only when the registry has no entry, and refuses without them", async () => {
    await expect(fakeCoordinator({ chainName: "hashkey-testnet", pinned: HUB }).adapter.init(31337)).resolves.toEqual({
      chainName: "hashkey-testnet",
      verifyingContract: HUB,
      source: "fallback",
    });
    await expect(fakeCoordinator({ chainsStatus: 503, chainName: "x", pinned: HUB }).adapter.init(133)).resolves.toMatchObject({ source: "fallback" });
    await expect(fakeCoordinator({ chainName: "x" }).adapter.init(31337)).rejects.toThrow(/HSP_VERIFYING_CONTRACT/);
    await expect(fakeCoordinator({ chains: { unexpected: true } }).adapter.init(133)).rejects.toThrow(/unexpected response shape/);
    expect(() => fakeCoordinator({}).adapter.verifyingContract).toThrow(/before init/);
  });
});

describe("local HSP adapter and verifier", () => {
  function log(address: Address, topics: Hex[], data: Hex, logIndex: number): Log {
    return { address, topics: topics as [Hex, ...Hex[]], data, logIndex, blockHash: TX, blockNumber: 1n, transactionHash: TX, transactionIndex: 0, removed: false };
  }
  function receipt(opts: { amount?: bigint; status?: "success" | "reverted"; withTransfer?: boolean } = {}): TransactionReceipt {
    const amount = opts.amount ?? 350_000n;
    const logs: Log[] = [
      log(TOKEN, encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER.address, to: RECIPIENT } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [amount]), 3),
      log(HUB, encodeEventTopics({ abi: clearingHubAbi, eventName: "NetTransfer", args: { batchId: BATCH, from: PAYER.address, to: RECIPIENT } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [amount]), 4),
    ];
    return { status: opts.status ?? "success", logs: opts.withTransfer === false ? logs.slice(1) : logs } as unknown as TransactionReceipt;
  }
  const onchainBatch = { token: TOKEN, settledAt: 1_800_000_000n };

  it("observes a matching NetTransfer plus token Transfer in a successful tx", () => {
    expect(observeSettlement(receipt(), body(), HUB, onchainBatch)).toMatchObject({ settlementVerified: true, nettingBatch: true, logIndex: 4 });
    expect(observeSettlement(receipt({ amount: 1n }), body(), HUB, onchainBatch).settlementVerified).toBe(false);
    expect(observeSettlement(receipt({ withTransfer: false }), body(), HUB, onchainBatch).settlementVerified).toBe(false);
    expect(observeSettlement(receipt({ status: "reverted" }), body(), HUB, onchainBatch).settlementVerified).toBe(false);
    expect(observeSettlement(receipt(), body(), HUB, { token: TOKEN, settledAt: 0n }).nettingBatch).toBe(false);
    expect(decodeAddressPayload(body().signer.payload).toLowerCase()).toBe(PAYER.address.toLowerCase());
  });

  async function signedReceipt(signer: typeof ADAPTER, satisfied: string[], b = body()): Promise<LocalHspReceipt> {
    const paymentId = hspPaymentId(31337, HUB, b);
    const signature = await signer.signTypedData({
      domain: { name: "HSP", version: "1", chainId: 31337, verifyingContract: HUB },
      types: hspReceiptTypes,
      primaryType: "Receipt",
      message: { paymentId, txHash: TX, logIndex: 4n, satisfiedCapabilitiesHash: requiredCapabilitiesHash(satisfied) },
    });
    return { paymentId, txHash: TX, logIndex: 4, satisfiedCapabilities: satisfied, adapter: signer.address, signature };
  }

  it("ACCEPTs only a pinned-adapter receipt that satisfies every required capability", async () => {
    const all = [CAPABILITIES.settlementVerified, CAPABILITIES.mandateBound, CAPABILITIES.nettingBatch];
    const args = { chainId: 31337, verifyingContract: HUB, body: body(), required: LOCAL_REQUIRED_CAPABILITIES, pinnedAdapter: ADAPTER.address };
    expect(await verifyLocalReceipt({ ...args, receipt: await signedReceipt(ADAPTER, all) })).toBe("ACCEPT");
    expect(await verifyLocalReceipt({ ...args, receipt: await signedReceipt(ADAPTER, all.slice(0, 2)) })).toBe("REJECT");
    expect(await verifyLocalReceipt({ ...args, receipt: await signedReceipt(IMPOSTOR, all) })).toBe("REJECT");
    // Tampering with the satisfied set after signing breaks the signature.
    const tampered = await signedReceipt(ADAPTER, all.slice(0, 2));
    expect(await verifyLocalReceipt({ ...args, receipt: { ...tampered, satisfiedCapabilities: all } })).toBe("REJECT");
    // A receipt for another mandate is rejected.
    const other = await signedReceipt(ADAPTER, all, { ...body(), amount: 1n });
    expect(await verifyLocalReceipt({ ...args, receipt: other })).toBe("REJECT");
    // The mandate must commit to the same required set the verifier applies.
    expect(await verifyLocalReceipt({ ...args, body: body([]), receipt: await signedReceipt(ADAPTER, all, body([])) })).toBe("REJECT");
  });

  it("the debtor co-signature is a valid HSP signature over the batch-bound mandate", async () => {
    const b = body();
    const sig = await PAYER.signTypedData(hspTypedData(31337, HUB, b));
    const { isHspMandateSignedBy } = await import("@payminto/protocol");
    expect(await isHspMandateSignedBy(31337, HUB, b, sig, PAYER.address)).toBe(true);
    expect(b.settlementBinding).toBe(BATCH);
  });
});

describe("local HSP adapter on a load-balanced RPC", () => {
  const adapterWith = (readContract: (args: { blockNumber?: bigint }) => Promise<unknown>) =>
    new LocalHspAdapter({
      chainId: 31337,
      hub: HUB,
      verifyingContract: HUB,
      adapterAccount: ADAPTER,
      publicClient: {
        getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n, transactionHash: TX, logs: [] }),
        readContract,
      } as never,
    });

  it("reads the hub at the settlement's own block, never at a floating latest", async () => {
    const reads: Array<bigint | undefined> = [];
    const adapter = adapterWith(async ({ blockNumber }) => {
      reads.push(blockNumber);
      return ["0x" + "00".repeat(32), TOKEN, HUB, 1_800_000_000n, 1n, 1n];
    });
    const b = body();
    await adapter.settle({ paymentId: hspPaymentId(31337, HUB, b), body: b, signerProof: "0x12", txHash: TX, batchId: BATCH });
    expect(reads).toEqual([100n]);
  });

  it("answers a backend that lacks that block with a retryable FAILED, not a final REJECT", async () => {
    const adapter = adapterWith(async () => {
      throw new Error("header not found");
    });
    const b = body();
    const out = await adapter.settle({ paymentId: hspPaymentId(31337, HUB, b), body: b, signerProof: "0x12", txHash: TX, batchId: BATCH });
    expect(out).toMatchObject({ status: "FAILED", retry: true });
  });
});
