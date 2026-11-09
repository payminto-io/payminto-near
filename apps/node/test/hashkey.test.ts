/**
 * HashKey Chain behaviour against a real anvil: finality (included at one confirmation, confirmed at the safe head),
 * reorged-out settlements, same-nonce fee-bump replacement, USDC.e-style blacklist screening, gasless onboarding with
 * an EIP-2612 permit, the operator fee preflight, and the HSP Coordinator chain registry at startup.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, getAddress, keccak256, maxUint256, toBytes, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  clearingHubAbi,
  clearingHubBytecode,
  mandateId as computeMandateId,
  mandateToJson,
  mandateTypedData,
  mockFiatTokenAbi,
  mockFiatTokenBytecode,
  payeesRoot,
  permitTypedData,
  policyHash,
  voucherTypedData,
  type Mandate,
} from "@payminto/protocol";
import { ChainClient, OperatorFundsError } from "../src/chain.ts";
import type { Config } from "../src/config.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { silentLogger } from "../src/logger.ts";
import { ANVIL_KEYS, deployClearing, mint, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const OWNER = privateKeyToAccount(ANVIL_KEYS[1]);
const USDC = 1_000_000n;

type Ctx = { anvil: Anvil; node: ClearingNode; hub: Address; token: Address; chainId: number };

async function rpc<T = unknown>(anvil: Anvil, method: string, params: unknown[] = []): Promise<T> {
  return (await (anvil.pub.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({ method, params })) as T;
}

async function api<T = any>(ctx: Ctx, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${ctx.node.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

async function buildMandate(ctx: Ctx, agent: Address, label: string) {
  const now = (await ctx.anvil.pub.getBlock()).timestamp;
  const policy = { perCallCap: "100000", dailyCap: (100n * USDC).toString(), maxCallsPerMinute: 0, purpose: label };
  const m: Mandate = {
    owner: OWNER.address,
    agent,
    token: ctx.token,
    totalCap: 100n * USDC,
    validAfter: now - 60n,
    validUntil: now + 86_400n,
    payeesRoot: payeesRoot([]),
    policyHash: policyHash(policy),
    salt: keccak256(toBytes(label)),
  };
  const ownerSignature = await OWNER.signTypedData(mandateTypedData(ctx.chainId, ctx.hub, m));
  return { m, policy, ownerSignature, id: computeMandateId(ctx.chainId, ctx.hub, m) };
}

async function openMandate(ctx: Ctx, agent: PrivateKeyAccount, label: string, approve = true): Promise<Hex> {
  const { m, policy, ownerSignature, id } = await buildMandate(ctx, agent.address, label);
  const r = await api(ctx, "POST", "/v1/mandates", { mandate: mandateToJson(m), ownerSignature, policy, payees: [], label });
  expect(r.status).toBe(201);
  if (approve) {
    const w = ctx.anvil.wallet(ANVIL_KEYS[ANVIL_KEYS.findIndex((k) => privateKeyToAccount(k).address === agent.address)]!);
    await ctx.anvil.pub.waitForTransactionReceipt({
      hash: await w.writeContract({ address: ctx.token, abi: erc20Abi, functionName: "approve", args: [ctx.hub, maxUint256] }),
    });
  }
  return id;
}

async function provider(ctx: Ctx, payee: Address, name: string): Promise<string> {
  const r = await api<{ id: string }>(ctx, "POST", "/v1/providers", { name, payee, priceAtomic: "1000", resource: `/${name}` });
  expect(r.status).toBe(201);
  return r.json.id;
}

async function pay(ctx: Ctx, agent: PrivateKeyAccount, mandateId: Hex, providerId: string, times = 1) {
  const p = ctx.node.services.store.provider(providerId)!;
  for (let i = 0; i < times; i++) {
    const cumulative = ctx.node.services.store.position(mandateId, p.payee).cumulative + BigInt(p.price_atomic);
    const signature = await agent.signTypedData(voucherTypedData(ctx.chainId, ctx.hub, { mandateId, payee: p.payee, cumulative }));
    const r = await ctx.node.services.vouchers.accept(p, {
      mandateId,
      payee: p.payee,
      amount: BigInt(p.price_atomic),
      cumulative,
      signature,
      requestHash: keccak256(toBytes(`${providerId}:${cumulative}`)),
    });
    if (!r.ok) throw new Error(`unexpected denial ${r.rule}`);
  }
}

const journals = (ctx: Ctx) => ctx.node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journals WHERE kind = 'batch.settled'")!.n;

async function boot(over: (hub: Address, token: Address) => Partial<Config> = () => ({}), fiat = false): Promise<Ctx & { tmp: ReturnType<typeof tempDir> }> {
  const anvil = await startAnvil();
  let hub: Address;
  let token: Address;
  if (fiat) {
    hub = await anvil.deploy(clearingHubAbi as Abi, clearingHubBytecode);
    token = await anvil.deploy(mockFiatTokenAbi as Abi, mockFiatTokenBytecode);
  } else ({ hub, token } = await deployClearing(anvil));
  const tmp = tempDir("payminto-hashkey-");
  const cfg = testConfig({ rpcUrl: anvil.rpcUrl, hub, token, dbPath: tmp.dbPath, adminToken: ADMIN, hsp: { mode: "local", verifyingContract: hub, cosignTimeoutSec: 1 }, ...over(hub, token) });
  const node = await startNode(cfg, { logger: silentLogger, port: 0, workers: false });
  return { anvil, node, hub, token, chainId: 31337, tmp };
}

describe("finality: included at one confirmation, confirmed at the safe head", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  const AGENT = privateKeyToAccount(ANVIL_KEYS[2]);
  let mandate: Hex;
  let prov: string;

  beforeAll(async () => {
    ctx = await boot(() => ({ confirmTag: "safe" }));
    mandate = await openMandate(ctx, AGENT, "finality");
    await mint(ctx.anvil, ctx.token, AGENT.address, 10n * USDC);
    prov = await provider(ctx, "0x00000000000000000000000000000000000a11ce", "svc");
  }, 60_000);
  afterAll(async () => {
    await ctx?.node.stop();
    ctx?.anvil.stop();
    ctx?.tmp.cleanup();
  });

  it("books nothing at inclusion, then confirms, posts the ledger and runs HSP once the safe head passes the block", async () => {
    await pay(ctx, AGENT, mandate, prov, 3);
    const r = await api<{ batchIds: Hex[] }>(ctx, "POST", "/v1/settlements");
    const id = r.json.batchIds[0]!;
    let b = (await api(ctx, "GET", `/v1/batches/${id}`)).json;
    expect(b.status).toBe("included");
    expect(b.includedAt).toBeTruthy();
    expect(b.confirmedAt).toBeNull();
    expect(b.gasUsed).toMatch(/^\d+$/);
    expect(b.l1Fee).toBeNull(); // plain anvil is not an OP Stack chain
    expect(journals(ctx)).toBe(0);
    expect(ctx.node.services.store.position(mandate, ctx.node.services.store.provider(prov)!.payee).settled).toBe(0n);
    expect(b.netTransfers[0].hsp.status).toBe("UNSIGNED");
    const hspAttempts = () => ctx.node.services.db.get<{ n: number }>("SELECT SUM(attempts) AS n FROM hsp_payments")!.n;
    expect(hspAttempts()).toBe(0); // the HSP step waits for finality
    // The pair is in flight: new calls on it wait for the next batch after this one confirms.
    await pay(ctx, AGENT, mandate, prov, 1);
    expect((await api(ctx, "GET", "/v1/netting/preview")).json.claims).toBe(0);
    expect((await api(ctx, "POST", "/v1/settlements")).json).toEqual({ skipped: "nothing to settle" });

    // anvil's safe head trails latest by 32 blocks.
    await ctx.node.services.settlement.trackFinality();
    expect((await api(ctx, "GET", `/v1/batches/${id}`)).json.status).toBe("included");
    await rpc(ctx.anvil, "anvil_mine", ["0x28"]);
    await ctx.node.services.settlement.trackFinality();
    b = (await api(ctx, "GET", `/v1/batches/${id}`)).json;
    expect(b.status).toBe("confirmed");
    expect(b.reconciled).toBe(true);
    expect(journals(ctx)).toBe(1);
    expect(hspAttempts()).toBe(1);
    // Promoting twice books once.
    await ctx.node.services.settlement.trackFinality();
    expect(journals(ctx)).toBe(1);
    const types = ctx.node.services.events.since(0, 10_000).map((e) => e.type);
    expect(types.indexOf("batch.included")).toBeGreaterThan(types.indexOf("batch.submitted"));
    expect(types.indexOf("batch.confirmed")).toBeGreaterThan(types.indexOf("batch.included"));
    expect((await api(ctx, "GET", "/v1/info")).json.settlement.confirmTag).toBe("safe");
    // The waiting call settles in the next batch.
    expect((await api(ctx, "GET", "/v1/netting/preview")).json.claims).toBe(1);
  }, 60_000);

  it("rebroadcasts a settlement that a reorg removed and books it exactly once", async () => {
    await rpc(ctx.anvil, "anvil_mine", ["0x28"]);
    await ctx.node.services.settlement.trackFinality();
    const snap = await rpc<Hex>(ctx.anvil, "evm_snapshot");
    const r = await api<{ batchIds: Hex[] }>(ctx, "POST", "/v1/settlements");
    const id = r.json.batchIds[0]!;
    const before = ctx.node.services.store.batch(id)!;
    expect(before.status).toBe("included");
    const journalsBefore = journals(ctx);

    // Reorg: the block with the settlement disappears, and with it the receipt.
    await rpc(ctx.anvil, "evm_revert", [snap]);
    expect(await ctx.node.services.chain.receiptOf(before.tx_hash!)).toBeNull();
    await ctx.node.services.settlement.trackFinality(); // detects it and rebroadcasts the same signed transaction
    await ctx.node.services.settlement.trackFinality(); // sees it included again
    const again = ctx.node.services.store.batch(id)!;
    expect(again.status).toBe("included");
    expect(again.tx_hash).toBe(before.tx_hash); // same signed transaction, same nonce
    await rpc(ctx.anvil, "anvil_mine", ["0x28"]);
    await ctx.node.services.settlement.trackFinality();
    expect(ctx.node.services.store.batch(id)!.status).toBe("confirmed");
    expect(journals(ctx)).toBe(journalsBefore + 1);
    expect((await api(ctx, "GET", "/v1/ledger/trial-balance")).json.balance).toBe("0");
  }, 60_000);

  it("fails a reorged-out batch whose nonce another transaction took, and settles its calls in a new batch", async () => {
    await pay(ctx, AGENT, mandate, prov, 2);
    const snap = await rpc<Hex>(ctx.anvil, "evm_snapshot");
    const id = (await api<{ batchIds: Hex[] }>(ctx, "POST", "/v1/settlements")).json.batchIds[0]!;
    expect(ctx.node.services.store.batch(id)!.status).toBe("included");
    await rpc(ctx.anvil, "evm_revert", [snap]);
    // The operator's nonce is now used by something else, so the removed settlement can never be mined.
    const op = ctx.anvil.wallet(ANVIL_KEYS[9]);
    await ctx.anvil.pub.waitForTransactionReceipt({ hash: await op.sendTransaction({ to: OWNER.address, value: 1n }) });
    // One tick is not enough: a load-balanced RPC can briefly look like this for a batch that landed.
    await ctx.node.services.settlement.trackFinality();
    await ctx.node.services.settlement.trackFinality();
    expect(ctx.node.services.store.batch(id)!.status).not.toBe("failed");
    await ctx.node.services.settlement.trackFinality();
    const failed = ctx.node.services.store.batch(id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/nonce reused/);
    expect((await api(ctx, "GET", "/v1/netting/preview")).json.claims).toBe(1);
    const next = (await api<{ batchIds: Hex[] }>(ctx, "POST", "/v1/settlements")).json.batchIds[0]!;
    await rpc(ctx.anvil, "anvil_mine", ["0x28"]);
    await ctx.node.services.settlement.trackFinality();
    expect(ctx.node.services.store.batch(next)!.status).toBe("confirmed");
    expect((await api(ctx, "GET", "/v1/ledger/trial-balance")).json.balance).toBe("0");
  }, 60_000);
});

describe("transaction replacement and RPC", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  const AGENT = privateKeyToAccount(ANVIL_KEYS[3]);
  let mandate: Hex;
  let prov: string;

  beforeAll(async () => {
    ctx = await boot(() => ({ tx: { bumpAfterBlocks: 2, maxBumps: 3, inclusionTimeoutSec: 60 } }));
    mandate = await openMandate(ctx, AGENT, "replacement");
    await mint(ctx.anvil, ctx.token, AGENT.address, 10n * USDC);
    prov = await provider(ctx, "0x00000000000000000000000000000000000b0b00", "svc");
  }, 60_000);
  afterAll(async () => {
    await ctx?.node.stop();
    ctx?.anvil.stop();
    ctx?.tmp.cleanup();
  });

  it("replaces a settlement that is not included after N blocks with the same nonce and 12.5 % higher fees", async () => {
    await pay(ctx, AGENT, mandate, prov, 2);
    await rpc(ctx.anvil, "evm_setAutomine", [false]);
    let miner: ReturnType<typeof setInterval> | null = null;
    try {
      const settling = api<{ batchIds: Hex[] }>(ctx, "POST", "/v1/settlements");
      // Wait for the first broadcast, then make it vanish from the pool, like a transaction a sequencer dropped.
      let first: { tx_hash: Hex; tx_nonce: number } | undefined;
      for (let i = 0; i < 200 && !first; i++) {
        first = ctx.node.services.db.get<{ tx_hash: Hex; tx_nonce: number }>("SELECT tx_hash, tx_nonce FROM batches WHERE status = 'submitted'");
        if (!first) await new Promise((r) => setTimeout(r, 50));
      }
      expect(first).toBeTruthy();
      const original = await ctx.anvil.pub.getTransaction({ hash: first!.tx_hash });
      await rpc(ctx.anvil, "anvil_dropTransaction", [first!.tx_hash]);
      miner = setInterval(() => void rpc(ctx.anvil, "anvil_mine", ["0x1"]).catch(() => undefined), 100);
      const r = await settling;
      const b = (await api(ctx, "GET", `/v1/batches/${r.json.batchIds[0]}`)).json;
      expect(b.status).toBe("confirmed");
      expect(b.replacements).toBeGreaterThanOrEqual(1);
      expect(b.txHash).not.toBe(first!.tx_hash);
      const mined = await ctx.anvil.pub.getTransaction({ hash: b.txHash });
      expect(mined.nonce).toBe(original.nonce);
      expect(mined.maxFeePerGas! * 1000n).toBeGreaterThanOrEqual(original.maxFeePerGas! * 1125n);
      expect(mined.maxPriorityFeePerGas! * 1000n).toBeGreaterThanOrEqual(original.maxPriorityFeePerGas! * 1125n);
    } finally {
      if (miner) clearInterval(miner);
      await rpc(ctx.anvil, "evm_setAutomine", [true]);
    }
  }, 60_000);

  it("refuses to broadcast what the operator cannot pay (L2 gas plus L1 data fee)", async () => {
    const broke = new ChainClient({ chainId: 31337, rpcUrl: ctx.anvil.rpcUrl, hub: ctx.hub, token: ctx.token, operatorKey: generatePrivateKey(), rpcRetries: 0 });
    await expect(broke.send({ to: OWNER.address, data: "0x" })).rejects.toBeInstanceOf(OperatorFundsError);
    // No GasPriceOracle on plain anvil: the L1 component is zero; on HashKey Chain forks it is read from the oracle.
    expect((await ctx.node.services.chain.estimateFee({ to: OWNER.address, data: "0x" })).l1Fee).toBe(0n);
  });

  it("treats a token without isBlacklisted as having no blacklist", async () => {
    const chain = ctx.node.services.chain;
    expect(await chain.supportsBlacklist(ctx.token)).toBe(false);
    expect(await chain.blacklisted([OWNER.address, AGENT.address])).toEqual(new Set());
  });
});

describe("USDC.e blacklist screening", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  const GOOD = privateKeyToAccount(ANVIL_KEYS[4]);
  const BAD = privateKeyToAccount(ANVIL_KEYS[5]);
  const OK_PAYEE = getAddress("0x0000000000000000000000000000000000000a0a");
  const BAD_PAYEE = getAddress("0x0000000000000000000000000000000000000b0b");

  beforeAll(async () => {
    ctx = await boot(() => ({}), true);
  }, 60_000);
  afterAll(async () => {
    await ctx?.node.stop();
    ctx?.anvil.stop();
    ctx?.tmp.cleanup();
  });

  it("drops claims of a blacklisted agent and to a blacklisted payee, warns, and settles the rest", async () => {
    const good = await openMandate(ctx, GOOD, "good");
    const bad = await openMandate(ctx, BAD, "bad");
    for (const a of [GOOD, BAD]) await mint(ctx.anvil, ctx.token, a.address, 10n * USDC);
    const okProv = await provider(ctx, OK_PAYEE, "ok");
    const badProv = await provider(ctx, BAD_PAYEE, "bad");
    await pay(ctx, GOOD, good, okProv, 2);
    await pay(ctx, GOOD, good, badProv, 1);
    await pay(ctx, BAD, bad, okProv, 1);
    const w = ctx.anvil.wallet(ANVIL_KEYS[0]);
    for (const who of [BAD.address, BAD_PAYEE]) {
      await ctx.anvil.pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: ctx.token, abi: mockFiatTokenAbi, functionName: "blacklist", args: [who] }) });
    }
    expect(await ctx.node.services.chain.supportsBlacklist()).toBe(true);
    expect(await ctx.node.services.chain.blacklisted([GOOD.address, BAD.address, BAD_PAYEE])).toEqual(new Set([BAD.address.toLowerCase(), BAD_PAYEE.toLowerCase()]));

    const r = await api<{ batchIds: Hex[]; dropped: Array<{ mandateId: Hex; payee: Address; reason: string }> }>(ctx, "POST", "/v1/settlements");
    expect(r.json.dropped).toEqual(
      expect.arrayContaining([
        { mandateId: bad, payee: OK_PAYEE, reason: `agent ${BAD.address} is blacklisted by the settlement token` },
        { mandateId: good, payee: BAD_PAYEE, reason: `payee ${BAD_PAYEE} is blacklisted by the settlement token` },
      ]),
    );
    const b = (await api(ctx, "GET", `/v1/batches/${r.json.batchIds[0]}`)).json;
    expect(b.status).toBe("confirmed");
    expect(b.claimList).toHaveLength(1);
    expect(await ctx.anvil.pub.readContract({ address: ctx.token, abi: erc20Abi, functionName: "balanceOf", args: [OK_PAYEE] })).toBe(2_000n);
    const warnings = ctx.node.services.events.since(0, 10_000).filter((e) => e.type === "funds.warning").map((e) => (e.warning as { reason: string }).reason);
    expect(warnings.filter((x) => /blacklisted/.test(x))).toHaveLength(2);
    // The blacklisted claims stay pending, not lost.
    expect((await api(ctx, "GET", "/v1/netting/preview")).json.claims).toBe(2);
  }, 60_000);
});

describe("gasless agent onboarding with an EIP-2612 permit", () => {
  let ctx: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    ctx = await boot();
  }, 60_000);
  afterAll(async () => {
    await ctx?.node.stop();
    ctx?.anvil.stop();
    ctx?.tmp.cleanup();
  });

  async function permit(agent: PrivateKeyAccount, value: bigint, signer = agent) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const signature = await signer.signTypedData(
      permitTypedData({ name: "USD Coin", version: "1", chainId: 31337, verifyingContract: ctx.token }, { owner: agent.address, spender: ctx.hub, value, nonce: 0n, deadline }),
    );
    return { value: value.toString(), deadline: deadline.toString(), signature };
  }

  it("opens the mandate and sets the allowance for an agent with no native token and no transactions", async () => {
    const agent = privateKeyToAccount(generatePrivateKey());
    expect(await ctx.anvil.pub.getBalance({ address: agent.address })).toBe(0n);
    const { m, policy, ownerSignature, id } = await buildMandate(ctx, agent.address, "gasless");
    const r = await api(ctx, "POST", "/v1/mandates", { mandate: mandateToJson(m), ownerSignature, policy, payees: [], label: "gasless", permit: await permit(agent, 50n * USDC) });
    expect(r.status).toBe(201);
    expect(r.json.status).toBe("open");
    expect(await ctx.anvil.pub.readContract({ address: ctx.token, abi: erc20Abi, functionName: "allowance", args: [agent.address, ctx.hub] })).toBe(50n * USDC);

    await mint(ctx.anvil, ctx.token, agent.address, 5n * USDC);
    const prov = await provider(ctx, "0x0000000000000000000000000000000000000c0c", "svc");
    await pay(ctx, agent, id, prov, 3);
    const s = await api<{ batchIds: Hex[] }>(ctx, "POST", "/v1/settlements");
    expect((await api(ctx, "GET", `/v1/batches/${s.json.batchIds[0]}`)).json.status).toBe("confirmed");
    expect(await ctx.anvil.pub.getTransactionCount({ address: agent.address })).toBe(0);
    expect(await ctx.anvil.pub.getBalance({ address: agent.address })).toBe(0n);
  }, 60_000);

  it("rejects a permit signed by someone else with a clear 400 and opens nothing", async () => {
    const agent = privateKeyToAccount(generatePrivateKey());
    const { m, policy, ownerSignature, id } = await buildMandate(ctx, agent.address, "bad-permit");
    const r = await api(ctx, "POST", "/v1/mandates", {
      mandate: mandateToJson(m),
      ownerSignature,
      policy,
      payees: [],
      label: "bad-permit",
      permit: await permit(agent, USDC, privateKeyToAccount(generatePrivateKey())),
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("BAD_PERMIT");
    expect(await ctx.node.services.chain.mandate(id)).toBeNull();
  });
});

describe("HSP Coordinator chain registry at startup", () => {
  let anvil: Anvil;
  let hub: Address;
  let token: Address;
  const tmp = tempDir("payminto-coord-");
  const REGISTRY_VC = "0x00000000000000000000000000000000000000C0" as Address;

  beforeAll(async () => {
    anvil = await startAnvil();
    ({ hub, token } = await deployClearing(anvil));
  }, 60_000);
  afterAll(() => {
    anvil?.stop();
    tmp.cleanup();
  });

  const fakeFetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/chains")) {
      return Response.json([
        { name: "hashkey", chainId: 177, verifyingContract: "0x00000000000000000000000000000000000000AA", stablecoin: {} },
        { name: "local-anvil", chainId: 31337, verifyingContract: REGISTRY_VC, adapterAddress: REGISTRY_VC },
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const coordinatorConfig = (pinned?: Address): Config =>
    testConfig({
      rpcUrl: anvil.rpcUrl,
      hub,
      token,
      dbPath: `${tmp.dir}/${pinned ? "pinned" : "open"}.test.db`,
      adminToken: ADMIN,
      hsp: {
        mode: "coordinator",
        coordinatorUrl: "https://coordinator.example",
        apiKey: "k",
        chainName: "fallback-name",
        verifyingContract: pinned ?? hub,
        verifyingContractPinned: !!pinned,
        requiredCapabilities: ["proves:settlement-verified:v1"],
        cosignTimeoutSec: 1,
      },
    });

  it("resolves the verifying contract by chain id and refuses to start when the pin differs", async () => {
    const node = await startNode(coordinatorConfig(), { logger: silentLogger, port: 0, workers: false, fetch: fakeFetch });
    try {
      const info = (await (await fetch(`${node.url}/v1/info`)).json()) as { hsp: { verifyingContract: string; requiredCapabilities: string[] } };
      expect(info.hsp.verifyingContract).toBe(REGISTRY_VC);
      expect(info.hsp.requiredCapabilities).toEqual(["proves:settlement-verified:v1"]);
    } finally {
      await node.stop();
    }
    await expect(
      startNode(coordinatorConfig("0x00000000000000000000000000000000000000BB"), { logger: silentLogger, port: 0, workers: false, fetch: fakeFetch }),
    ).rejects.toThrow(/differs from the Coordinator registry/);
  }, 60_000);
});
