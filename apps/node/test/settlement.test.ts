/**
 * Settlement worker edge paths against a real anvil: more than 64 claims (chunking), an agent that cannot fund
 * its net debit (dropped with funds.warning), debtors that never co-sign (UNSIGNED HSP records), a batch whose
 * simulation reverts (calls return to accepted), and a restart on the same database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, getAddress, type Abi, keccak256, maxUint256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { clearingHubAbi, clearingHubBytecode, mandateToJson, mandateTypedData, mandateId as computeMandateId, payeesRoot, policyHash, voucherTypedData, type Mandate } from "@payminto/protocol";
import { startNode, type ClearingNode } from "../src/server.ts";
import { silentLogger } from "../src/logger.ts";
import { ANVIL_KEYS, deployClearing, mint, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const OWNER = privateKeyToAccount(ANVIL_KEYS[1]);
const RICH = privateKeyToAccount(ANVIL_KEYS[2]);
const POOR = privateKeyToAccount(ANVIL_KEYS[3]);
const USDC = 1_000_000n;

let anvil: Anvil;
let node: ClearingNode;
let hub: Address;
let token: Address;
const tmp = tempDir("payminto-settle-");
const config = () => testConfig({ rpcUrl: anvil.rpcUrl, hub, token, dbPath: tmp.dbPath, adminToken: ADMIN, hsp: { mode: "local", verifyingContract: hub, cosignTimeoutSec: 1 } });

async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${node.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

async function openMandate(agent: PrivateKeyAccount, label: string): Promise<Hex> {
  const now = (await anvil.pub.getBlock()).timestamp;
  const policy = { perCallCap: "100000", dailyCap: (100n * USDC).toString(), maxCallsPerMinute: 0, purpose: label };
  const m: Mandate = {
    owner: OWNER.address,
    agent: agent.address,
    token,
    totalCap: 100n * USDC,
    validAfter: now - 60n,
    validUntil: now + 86_400n,
    payeesRoot: payeesRoot([]),
    policyHash: policyHash(policy),
    salt: keccak256(toBytes(label)),
  };
  const ownerSignature = await OWNER.signTypedData(mandateTypedData(31337, hub, m));
  const r = await api("POST", "/v1/mandates", { mandate: mandateToJson(m), ownerSignature, policy, payees: [], label });
  expect(r.status).toBe(201);
  return computeMandateId(31337, hub, m);
}

/** Pays through the node's voucher service directly (the HTTP path is covered by the e2e test). */
async function pay(agent: PrivateKeyAccount, mandateId: Hex, providerId: string, times = 1) {
  const provider = node.services.store.provider(providerId)!;
  for (let i = 0; i < times; i++) {
    const pos = node.services.store.position(mandateId, provider.payee).cumulative;
    const amount = BigInt(provider.price_atomic);
    const cumulative = pos + amount;
    const signature = await agent.signTypedData(voucherTypedData(31337, hub, { mandateId, payee: provider.payee, cumulative }));
    const r = await node.services.vouchers.accept(provider, {
      mandateId,
      payee: provider.payee,
      amount,
      cumulative,
      signature,
      requestHash: keccak256(toBytes(`${providerId}:${i}`)),
    });
    if (!r.ok) throw new Error(`unexpected denial ${r.rule}`);
  }
}

beforeAll(async () => {
  anvil = await startAnvil();
  ({ hub, token } = await deployClearing(anvil));
  node = await startNode(config(), { logger: silentLogger, port: 0, workers: false });
}, 60_000);

afterAll(async () => {
  await node?.stop();
  anvil?.stop();
  tmp.cleanup();
});

describe("settlement worker", () => {
  it("chunks 70 claims into two batches and drops an agent that cannot fund its net debit", async () => {
    const rich = await openMandate(RICH, "rich");
    const poor = await openMandate(POOR, "poor");
    await mint(anvil, token, RICH.address, 10n * USDC);
    await mint(anvil, token, POOR.address, 1_000n);
    for (const k of [ANVIL_KEYS[2], ANVIL_KEYS[3]]) {
      const w = anvil.wallet(k);
      await anvil.pub.waitForTransactionReceipt({
        hash: await w.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [hub, maxUint256] }),
      });
    }
    // 70 distinct payees -> 70 (mandate, payee) claims for the rich agent.
    const providers: string[] = [];
    for (let i = 0; i < 70; i++) {
      const payee = getAddress(`0x${(0x1000 + i).toString(16).padStart(40, "0")}`);
      const r = await api<{ id: string }>("POST", "/v1/providers", { name: `svc ${i}`, payee, priceAtomic: "1000", resource: `/r${i}` });
      providers.push(r.json.id);
    }
    for (const p of providers) await pay(RICH, rich, p, 2);
    // The poor agent can pay when it calls, then empties its wallet before settlement.
    await pay(POOR, poor, providers[0]!, 1);
    const drain = anvil.wallet(ANVIL_KEYS[3]);
    await anvil.pub.waitForTransactionReceipt({
      hash: await drain.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [OWNER.address, 1_000n] }),
    });

    const preview = await api("GET", "/v1/netting/preview");
    expect(preview.json.claims).toBe(71);
    expect(preview.json.batches).toBe(2);

    const r = await api<{ batchIds: Hex[]; dropped: Array<{ mandateId: Hex; reason: string }> }>("POST", "/v1/settlements");
    expect(r.status).toBe(200);
    expect(r.json.batchIds).toHaveLength(2);
    expect(r.json.dropped).toEqual([expect.objectContaining({ mandateId: poor, reason: "agent cannot fund its net debit" })]);
    for (const id of r.json.batchIds) {
      const b = await api("GET", `/v1/batches/${id}`);
      expect(b.json.status).toBe("confirmed");
      expect(b.json.reconciled).toBe(true);
      expect(b.json.claims).toBeLessThanOrEqual(64);
      // Nobody co-signed within HSP_COSIGN_TIMEOUT_SEC: the batch still settled and HSP shows UNSIGNED.
      expect(b.json.netTransfers.every((t: { hsp: { status: string; cosigned: boolean } }) => t.hsp.status === "UNSIGNED" && !t.hsp.cosigned)).toBe(true);
    }
    const claims = (await Promise.all(r.json.batchIds.map((id) => api("GET", `/v1/batches/${id}`)))).reduce((n, b) => n + b.json.claims, 0);
    expect(claims).toBe(70);
    expect(await anvil.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [RICH.address] })).toBe(10n * USDC - 140_000n);

    // The poor agent's call is still accepted and pending; a funds warning was emitted.
    const pending = await api<{ items: Array<{ mandateId: Hex; status: string }> }>("GET", `/v1/calls?mandateId=${poor}`);
    expect(pending.json.items.map((c) => c.status)).toEqual(["accepted"]);
    const warnings = node.services.events.since(0, 10_000).filter((e) => e.type === "funds.warning");
    expect(warnings.some((w) => (w.warning as { agent?: string }).agent === POOR.address)).toBe(true);
    expect((await api("GET", "/v1/ledger/trial-balance")).json.balance).toBe("0");
  }, 120_000);

  it("fails a batch whose simulation reverts and returns its calls to accepted", async () => {
    const db = node.services.db;
    const call = db.get<{ seq: number; agent_signature: Hex; mandate_id: Hex }>("SELECT seq, agent_signature, mandate_id FROM calls WHERE status = 'accepted'")!;
    // Fund the poor agent so the pre-check passes, then corrupt the stored voucher signature.
    await mint(anvil, token, POOR.address, USDC);
    const bad = `0x${"11".repeat(65)}`;
    db.run("UPDATE calls SET agent_signature = ? WHERE seq = ?", bad, call.seq);
    const r = await api<{ batchIds: Hex[] }>("POST", "/v1/settlements");
    expect(r.json.batchIds).toHaveLength(1);
    const failed = await api("GET", `/v1/batches/${r.json.batchIds[0]}`);
    expect(failed.json.status).toBe("failed");
    expect(failed.json.error).toBeTruthy();
    expect(failed.json.netTransfers.every((t: { hsp: { status: string } }) => t.hsp.status === "FAILED")).toBe(true);
    expect(db.get<{ status: string; batch_seq: number | null }>("SELECT status, batch_seq FROM calls WHERE seq = ?", call.seq)).toEqual({
      status: "accepted",
      batch_seq: null,
    });
    // Repair and settle again.
    db.run("UPDATE calls SET agent_signature = ? WHERE seq = ?", call.agent_signature, call.seq);
    const again = await api<{ batchIds: Hex[] }>("POST", "/v1/settlements");
    expect((await api("GET", `/v1/batches/${again.json.batchIds[0]}`)).json.status).toBe("confirmed");
    expect((await api("GET", `/v1/mandates/${call.mandate_id}`)).json.spend.pending).toBe("0");
  }, 60_000);

  it("restarts on the same database, recovers interrupted batches, and refuses a database from another hub", async () => {
    // Simulate a crash mid-batch: a batch row left in 'building' with a call attached.
    await pay(RICH, node.services.store.mandates().find((m) => m.agent === RICH.address)!.id, node.services.store.providers()[0]!.id, 1);
    const db = node.services.db;
    const { lastInsertRowid } = db.run("INSERT INTO batches (status, token, trigger, created_at) VALUES ('building', ?, 'manual', ?)", token, new Date().toISOString());
    db.run("UPDATE batches SET batch_id = ? WHERE seq = ?", keccak256(toBytes("crashed")), lastInsertRowid);
    db.run("UPDATE calls SET status = 'settling', batch_seq = ? WHERE status = 'accepted'", lastInsertRowid);
    await node.stop();

    node = await startNode(config(), { logger: silentLogger, port: 0, workers: false });
    const crashed = node.services.store.batch(String(lastInsertRowid))!;
    expect(crashed.status).toBe("failed");
    expect(node.services.store.unsettledCallCount()).toBe(1);
    expect((await api("POST", "/v1/settlements")).json.batchIds).toHaveLength(1);
    expect((await api("GET", "/v1/ledger/trial-balance")).json).toMatchObject({ balanced: true, balance: "0" });

    const otherHub = await anvil.deploy(clearingHubAbi as Abi, clearingHubBytecode);
    await expect(startNode({ ...config(), hub: otherHub, hsp: { mode: "local", verifyingContract: otherHub, cosignTimeoutSec: 1 } }, { logger: silentLogger, port: 0, workers: false })).rejects.toThrow(/belongs to hub=/);
  }, 60_000);
});
