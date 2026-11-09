/**
 * End to end: anvil + ClearingHub + MockStablecoin, the Clearing Node in-process on a temp SQLite file,
 * two real HTTP provider services behind the SDK paywall, two agents paying through AgentClient.fetch,
 * then one settlement that nets everything on chain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { erc20Abi, keccak256, maxUint256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clearingHubAbi, verifyReceiptProof, voucherTypedData, type ClearingReceipt } from "@payminto/protocol";
import { AgentClient, MemoryReceiptStore, OwnerClient, paywall, type DeniedEvent } from "@payminto/sdk";
import { startNode, type ClearingNode } from "../src/server.ts";
import { silentLogger } from "../src/logger.ts";
import { ANVIL_KEYS, deployClearing, freePort, mint, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const OWNER = privateKeyToAccount(ANVIL_KEYS[1]);
const AGENT_A = privateKeyToAccount(ANVIL_KEYS[2]);
const AGENT_B = privateKeyToAccount(ANVIL_KEYS[3]); // also the payee of "Research Writer"
const PAYEE_1 = privateKeyToAccount(ANVIL_KEYS[4]).address;
const ROGUE = privateKeyToAccount(ANVIL_KEYS[5]).address;

const USDC = 1_000_000n;
const PRICE_QUOTE = 2_000n;
const PRICE_BRIEF = 50_000n;
const PRICE_ROGUE = 1_000n;
const PRICE_PREMIUM = 100_000n;

let anvil: Anvil;
let node: ClearingNode;
let hub: Address;
let token: Address;
const tmp = tempDir();
const servers: Server[] = [];
const sseEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
let sseAbort: AbortController;
let marketUrl = "";

async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<{ status: number; json: T }> {
  const res = await fetch(`${node.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  // Optional contract dump: API_DUMP_DIR=... writes every response, for checking against the dashboard schemas.
  if (process.env.API_DUMP_DIR && res.ok) {
    writeFileSync(join(process.env.API_DUMP_DIR, `${method}${path.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80)}.json`), JSON.stringify(json, null, 2));
  }
  return { status: res.status, json };
}

function listen(app: Hono): Promise<string> {
  return new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
    servers.push(s as Server);
  });
}

async function collectSse(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) sseEvents.push({ event, data: JSON.parse(data) });
      }
    }
  } catch {
    // aborted
  }
}

const balanceOf = (who: Address) => anvil.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

beforeAll(async () => {
  anvil = await startAnvil();
  ({ hub, token } = await deployClearing(anvil));
  const port = await freePort();
  node = await startNode(
    testConfig({ rpcUrl: anvil.rpcUrl, hub, token, dbPath: tmp.dbPath, publicUrl: `http://127.0.0.1:${port}`, adminToken: ADMIN }),
    { logger: silentLogger, port },
  );
  sseAbort = new AbortController();
  void collectSse(`${node.url}/v1/events?token=${ADMIN}`, sseAbort.signal);
}, 60_000);

afterAll(async () => {
  sseAbort?.abort();
  for (const s of servers) s.close();
  await node?.stop();
  anvil?.stop();
  tmp.cleanup();
});

describe("clearing end to end", () => {
  const agentBStore = new MemoryReceiptStore();
  it("clears ~50 parallel paid calls in one netted batch, with HSP records and an on-chain proof", async () => {
    // --- providers, registered at the node and served behind the SDK paywall -------------------------
    const register = async (name: string, payee: Address, price: bigint, resource: string) => {
      const r = await api<{ id: string; apiKey: string }>("POST", "/v1/providers", {
        name,
        description: `${name} test service`,
        payee,
        priceAtomic: price.toString(),
        resource,
        category: "data",
      });
      expect(r.status).toBe(201);
      expect(r.json.apiKey).toMatch(/^pmk_/);
      return r.json;
    };
    const quote = await register("Market Data", PAYEE_1, PRICE_QUOTE, "/quote");
    const premium = await register("Premium Data", PAYEE_1, PRICE_PREMIUM, "/premium");
    const brief = await register("Research Writer", AGENT_B.address, PRICE_BRIEF, "/brief");
    const rogue = await register("Unlisted Service", ROGUE, PRICE_ROGUE, "/rogue");

    const pw = (p: { id: string; apiKey: string }, price: bigint) => paywall({ nodeUrl: node.url, providerId: p.id, apiKey: p.apiKey, price });
    const marketApp = new Hono();
    marketApp.get("/quote", pw(quote, PRICE_QUOTE).hono(), (c) => c.json({ pair: c.req.query("pair"), price: "1.2345" }));
    marketApp.get("/premium", pw(premium, PRICE_PREMIUM).hono(), (c) => c.json({ premium: true }));
    marketUrl = await listen(marketApp);

    // The writer service uses the framework-agnostic wrap() on a plain fetch handler.
    const briefPay = pw(brief, PRICE_BRIEF);
    const roguePay = pw(rogue, PRICE_ROGUE);
    const briefHandler = briefPay.wrap(async (req: Request) => Response.json({ brief: `about ${new URL(req.url).searchParams.get("topic")}` }));
    const rogueHandler = roguePay.wrap(async () => Response.json({ stolen: true }));
    const writerApp = new Hono();
    writerApp.all("/brief", (c) => briefHandler(c.req.raw));
    writerApp.all("/rogue", (c) => rogueHandler(c.req.raw));
    const writerUrl = await listen(writerApp);

    // Unpaid request -> 402 with an x402 v2 requirement.
    const unpaid = await fetch(`${marketUrl}/quote?pair=HSK-USDC`);
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("PAYMENT-REQUIRED")).toBeTruthy();

    // --- mandates -------------------------------------------------------------------------------------
    const owner = new OwnerClient({ nodeUrl: node.url, chainId: 31337, hub, account: OWNER, publicClient: anvil.pub, adminToken: ADMIN });
    const policyA = { perCallCap: "60000", dailyCap: (5n * USDC).toString(), maxCallsPerMinute: 1000, purpose: "treasury agent" };
    const policyB = { perCallCap: "10000", dailyCap: USDC.toString(), maxCallsPerMinute: 1000, purpose: "research writer buys data" };
    const payeesA = [PAYEE_1, AGENT_B.address];
    const payeesB = [PAYEE_1];
    const a = await owner.createMandate({ agent: AGENT_A.address, token, totalCap: 10n * USDC, validForSeconds: 86_400, payees: payeesA, policy: policyA });
    const b = await owner.createMandate({ agent: AGENT_B.address, token, totalCap: 2n * USDC, validForSeconds: 86_400, payees: payeesB, policy: policyB });
    const sa = await owner.submit({ ...a, policy: policyA, payees: payeesA, label: "Treasury Agent" });
    const sb = await owner.submit({ ...b, policy: policyB, payees: payeesB, label: "Research Writer" });
    expect(sa.status).toBe("open");
    expect(sb.status).toBe("open");
    const onchainA = await anvil.pub.readContract({ address: hub, abi: clearingHubAbi, functionName: "mandates", args: [a.mandateId] });
    expect((onchainA as readonly unknown[])[1]).toBe(AGENT_A.address);

    // --- agents: funded and approved once ---------------------------------------------------------------
    await mint(anvil, token, AGENT_A.address, 100n * USDC);
    await mint(anvil, token, AGENT_B.address, 10n * USDC);
    // Both agents are configured with their node; agent A also pins its operator address.
    const agentA = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: AGENT_A, mandateId: a.mandateId, trustedNode: node.services.chain.operator.address });
    const agentB = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: AGENT_B, mandateId: b.mandateId, receipts: agentBStore });
    // A second process of agent A on the same mandate (shares its receipt store), to exercise STALE_CUMULATIVE.
    const agentA2 = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: AGENT_A, mandateId: a.mandateId, receipts: agentA.receipts });
    expect(await agentA2.ensureAllowance(anvil.wallet(ANVIL_KEYS[2]), maxUint256, { token })).toMatch(/^0x/);
    expect(await agentB.ensureAllowance(anvil.wallet(ANVIL_KEYS[3]), maxUint256, { token })).toMatch(/^0x/);
    expect(await agentB.ensureAllowance(anvil.wallet(ANVIL_KEYS[3]), 1n, { token })).toBeNull();

    const denials: DeniedEvent[] = [];
    const receipts: ClearingReceipt[] = [];
    const errors: Error[] = [];
    for (const ag of [agentA, agentA2, agentB]) {
      ag.on("denied", (d) => denials.push(d));
      ag.on("receipt", (r) => receipts.push(r.receipt));
      ag.on("error", (e) => errors.push(e));
    }

    // --- STALE_CUMULATIVE retry: A caches its position, A2 moves it, A re-signs transparently --------------
    expect((await agentA.fetch(`${marketUrl}/quote?pair=warmup`)).status).toBe(200);
    expect((await agentA2.fetch(`${marketUrl}/quote?pair=other-process`)).status).toBe(200);
    const stale = await agentA.fetch(`${marketUrl}/quote?pair=after-race`);
    expect(stale.status).toBe(200);
    expect(denials).toHaveLength(0);
    const staleDenials = await api<Array<{ rule: string }>>("GET", "/v1/denials?limit=10");
    expect(staleDenials.json.map((d) => d.rule)).toEqual(["STALE_CUMULATIVE"]);

    // --- ~50 parallel paid calls, plus an over-cap call and a non-allowlisted payee ----------------------
    const jobs: Array<Promise<Response>> = [];
    for (let i = 0; i < 22; i++) jobs.push(agentA.fetch(`${marketUrl}/quote?pair=HSK-USDC&i=${i}`));
    for (let i = 0; i < 6; i++) {
      jobs.push(agentA.fetch(`${writerUrl}/brief?topic=t${i}`, { method: "POST", body: JSON.stringify({ topic: i }), headers: { "content-type": "application/json" } }));
    }
    for (let i = 0; i < 20; i++) jobs.push(agentB.fetch(`${marketUrl}/quote?pair=BTC-USDC&i=${i}`));
    const overCap = agentA.fetch(`${marketUrl}/premium`);
    const notAllowed = agentA.fetch(`${writerUrl}/rogue`);
    const results = await Promise.all(jobs);
    expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
    expect(results[0]!.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(await results[0]!.json()).toMatchObject({ pair: "HSK-USDC", price: "1.2345" });
    const over = await overCap;
    const na = await notAllowed;
    expect(over.status).toBe(402);
    expect(na.status).toBe(402);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("PER_CALL_CAP");
    expect(((await na.json()) as { error: { code: string } }).error.code).toBe("PAYEE_NOT_ALLOWED");
    expect(denials.map((d) => d.code).sort()).toEqual(["PAYEE_NOT_ALLOWED", "PER_CALL_CAP"]);
    // Agent A refused both before signing, so the node never saw them.
    expect(denials.every((d) => d.details?.enforcedBy === "agent")).toBe(true);
    expect((await api<unknown[]>("GET", "/v1/denials")).json).toHaveLength(1); // only the STALE_CUMULATIVE above
    expect(errors).toEqual([]);

    // Policy is enforced twice: a client that skips the pre-sign guard (a buggy or compromised agent) is still
    // refused by the node with the same rules.
    const unguarded = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: AGENT_A, mandateId: a.mandateId, enforcePolicy: false, receipts: agentA.receipts });
    const nodeOver = await unguarded.fetch(`${marketUrl}/premium`);
    const nodeNa = await unguarded.fetch(`${writerUrl}/rogue`);
    expect(((await nodeOver.json()) as { error: { code: string } }).error.code).toBe("PER_CALL_CAP");
    expect(((await nodeNa.json()) as { error: { code: string } }).error.code).toBe("PAYEE_NOT_ALLOWED");
    const nodeDenials = await api<Array<{ rule: string }>>("GET", "/v1/denials?limit=2");
    expect(nodeDenials.json.map((d) => d.rule).sort()).toEqual(["PAYEE_NOT_ALLOWED", "PER_CALL_CAP"]);
    // Regression: no client involved at all. A validly signed voucher above the per-call cap, posted straight to the
    // node by the provider, is denied with PER_CALL_CAP and recorded.
    const posPremium = BigInt((await api<{ cumulative: string }>("GET", `/v1/mandates/${a.mandateId}/position?payee=${PAYEE_1}`, undefined, false)).json.cumulative);
    const rawCumulative = posPremium + PRICE_PREMIUM;
    const rawSig = await AGENT_A.signTypedData(voucherTypedData(31337, hub, { mandateId: a.mandateId, payee: PAYEE_1, cumulative: rawCumulative }));
    const raw = await fetch(`${node.url}/v1/vouchers`, {
      method: "POST",
      headers: { authorization: `Bearer ${premium.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        scheme: "payminto-voucher",
        network: "eip155:31337",
        payload: { mandateId: a.mandateId, payee: PAYEE_1, amount: PRICE_PREMIUM.toString(), cumulative: rawCumulative.toString(), signature: rawSig, requestHash: keccak256(toBytes("raw")) },
        providerId: premium.id,
        requestHash: keccak256(toBytes("raw")),
      }),
    });
    expect(raw.status).toBe(402);
    expect(((await raw.json()) as { error: { code: string } }).error.code).toBe("PER_CALL_CAP");
    expect((await api<Array<{ rule: string }>>("GET", "/v1/denials?limit=1")).json[0]!.rule).toBe("PER_CALL_CAP");
    // The public policy route serves exactly what the mandate commits to.
    const served = await api<{ policy: unknown; payees: string[] }>("GET", `/v1/mandates/${a.mandateId}/policy`, undefined, false);
    expect(served.json.policy).toEqual(policyA);
    expect(served.json.payees).toEqual([...payeesA].sort());

    const acceptedCalls = 3 + jobs.length; // 51
    expect(receipts).toHaveLength(acceptedCalls);
    const posA = await agentA.position(PAYEE_1);
    expect(posA.cumulative).toBe(25n * PRICE_QUOTE);
    expect(posA.settled).toBe(0n);

    // --- netting preview --------------------------------------------------------------------------------
    const preview = await api("GET", "/v1/netting/preview");
    expect(preview.json.calls).toBe(acceptedCalls);
    expect(preview.json.claims).toBe(3);
    expect(preview.json.gross).toHaveLength(3);
    expect(preview.json.transfers).toBeLessThan(acceptedCalls);

    // --- settle: agent A co-signs its HSP mandates while the batch waits ---------------------------------
    agentA.startCosignLoop(100);
    agentB.startCosignLoop(100);
    const cosigned: Hex[] = [];
    agentA.on("cosigned", (c) => cosigned.push(c.hspPaymentId));
    const refused: string[] = [];
    agentA.on("cosignRefused", (c) => refused.push(c.reason));

    const before = { a: await balanceOf(AGENT_A.address), b: await balanceOf(AGENT_B.address), p1: await balanceOf(PAYEE_1) };
    const settle = await api<{ batchIds: Hex[] }>("POST", "/v1/settlements");
    agentA.stopCosignLoop();
    agentB.stopCosignLoop();
    expect(settle.status).toBe(200);
    expect(settle.json.batchIds).toHaveLength(1);
    const batchId = settle.json.batchIds[0]!;

    // On-chain balances move by exactly the net positions.
    const grossA = 25n * PRICE_QUOTE + 6n * PRICE_BRIEF;
    const grossB = 20n * PRICE_QUOTE;
    expect(await balanceOf(AGENT_A.address)).toBe(before.a - grossA);
    expect(await balanceOf(AGENT_B.address)).toBe(before.b + 6n * PRICE_BRIEF - grossB);
    expect(await balanceOf(PAYEE_1)).toBe(before.p1 + 45n * PRICE_QUOTE);
    expect(await balanceOf(hub)).toBe(0n);

    const batch = await api("GET", `/v1/batches/${batchId}`);
    expect(batch.json.status).toBe("confirmed");
    expect(batch.json.reconciled).toBe(true);
    expect(batch.json.calls).toBe(acceptedCalls);
    expect(batch.json.claims).toBe(3);
    expect(batch.json.transfers).toBeLessThan(batch.json.calls);
    expect(batch.json.transfers).toBe(batch.json.netTransfers.length);
    expect(BigInt(batch.json.gross)).toBe(grossA + grossB);
    expect(BigInt(batch.json.net)).toBeLessThan(BigInt(batch.json.gross));
    expect(batch.json.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Agent A is the only net debtor: every transfer is co-signed and the local HSP verifier ACCEPTs it.
    for (const t of batch.json.netTransfers) {
      expect(t.from).toBe(AGENT_A.address);
      expect(t.logIndex).not.toBeNull();
      expect(t.hsp.status).toBe("ACCEPT");
      expect(t.hsp.cosigned).toBe(true);
      expect(t.hsp.satisfiedCapabilities.sort()).toEqual(
        ["proves:payminto-mandate-bound:v1", "proves:payminto-netting-batch:v1", "proves:settlement-verified:v1"],
      );
    }
    expect(cosigned).toHaveLength(batch.json.netTransfers.length);
    expect(refused).toEqual([]);

    // Positions settled; ledger balances to zero.
    expect((await agentA.position(PAYEE_1)).settled).toBe(25n * PRICE_QUOTE);
    const tb = await api("GET", "/v1/ledger/trial-balance");
    expect(tb.json.balanced).toBe(true);
    expect(tb.json.balance).toBe("0");
    const payable = tb.json.accounts.find((x: { account: string }) => x.account === `agent:${AGENT_A.address}:payable`);
    expect(payable.balance).toBe("0");

    // Any single call is provable against the on-chain receipts root.
    const sample = receipts[17]!;
    const proof = await api("GET", `/v1/receipts/${sample.callId}/proof`, undefined, false);
    expect(proof.status).toBe(200);
    expect(proof.json.onchainVerified).toBe(true);
    expect(proof.json.batchId).toBe(batchId);
    const direct = await anvil.pub.readContract({
      address: hub,
      abi: clearingHubAbi,
      functionName: "verifyReceipt",
      args: [batchId, sample.leaf, proof.json.proof],
    });
    expect(direct).toBe(true);
    expect(
      verifyReceiptProof(
        proof.json.receiptsRoot,
        {
          callId: sample.callId,
          mandateId: sample.mandateId,
          payee: sample.payee,
          amount: BigInt(sample.amount),
          cumulative: BigInt(sample.cumulative),
          requestHash: sample.requestHash,
          timestamp: BigInt(sample.timestamp),
        },
        proof.json.proof,
      ),
    ).toBe(true);

    // Dashboard views.
    const ov = await api("GET", "/v1/overview");
    expect(ov.json.calls.all).toBe(acceptedCalls);
    expect(ov.json.calls.settled).toBe(acceptedCalls);
    expect(ov.json.denialsTotal).toBe(4); // STALE_CUMULATIVE, PER_CALL_CAP and PAYEE_NOT_ALLOWED from the unguarded client, the raw over-cap voucher
    expect(ov.json.compressionRatio).toBe(acceptedCalls / batch.json.transfers);
    expect(ov.json.lastBatch.id).toBe(batchId);
    expect(ov.json.activeMandates).toBe(2);
    const md = await api("GET", `/v1/mandates/${a.mandateId}`);
    expect(md.json.spend.settled).toBe(grossA.toString());
    expect(md.json.spend.pending).toBe("0");
    expect(md.json.onchain.spent).toBe(grossA.toString());
    expect((await api("GET", "/v1/netting/preview")).json.calls).toBe(0);
    expect(await api("POST", "/v1/settlements")).toMatchObject({ status: 200, json: { skipped: "nothing to settle" } });
    const catalog = await api<Array<{ id: string; calls24h: number }>>("GET", "/v1/providers", undefined, false);
    expect(catalog.json.find((p) => p.id === quote.id)!.calls24h).toBe(45);

    // Every list and detail view answers.
    for (const path of ["/v1/info", "/healthz", "/v1/mandates", `/v1/providers/${quote.id}`, "/v1/calls?limit=5", "/v1/denials", "/v1/batches", "/v1/ledger?limit=5", `/v1/ledger?account=agent:${AGENT_A.address}`]) {
      expect((await api("GET", path)).status, path).toBe(200);
    }
    const page1 = await api<{ items: Array<{ seq: number }>; nextCursor: string }>("GET", "/v1/calls?limit=20");
    const page2 = await api<{ items: Array<{ seq: number }> }>("GET", `/v1/calls?limit=20&cursor=${page1.json.nextCursor}`);
    expect(page2.json.items[0]!.seq).toBeLessThan(page1.json.items[19]!.seq);

    // SSE delivered the live stream.
    await new Promise((r) => setTimeout(r, 200));
    const types = new Set(sseEvents.map((e) => e.event));
    for (const t of ["call.accepted", "call.denied", "mandate.opened", "batch.started", "batch.submitted", "batch.confirmed", "hsp.updated"]) {
      expect(types.has(t), t).toBe(true);
    }
    expect(sseEvents.filter((e) => e.event === "call.accepted")).toHaveLength(acceptedCalls);
    const confirmed = sseEvents.find((e) => e.event === "batch.confirmed")!.data;
    expect(confirmed).toMatchObject({ type: "batch.confirmed", batch: { id: batchId, status: "confirmed" } });
    expect(typeof confirmed.id).toBe("string");
    expect(typeof confirmed.at).toBe("string");
  }, 120_000);

  it("revokes at the node immediately with an agent signature", async () => {
    const mandates = await api<Array<{ id: Hex; agent: Address; status: string }>>("GET", "/v1/mandates");
    const mb = mandates.json.find((m) => m.agent === AGENT_B.address)!;
    // Agent B restarted with the same receipt store, so it still knows the positions it signed.
    const agentB = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: AGENT_B, mandateId: mb.id, receipts: agentBStore });
    const r = (await agentB.revoke()) as { mandate: { status: string }; onchain: { submitted: boolean; call: { functionName: string } | null } };
    expect(r.mandate.status).toBe("revoked");
    // The operator is neither owner nor agent, so the node returns the call the owner must make.
    expect(r.onchain.submitted).toBe(false);
    expect(r.onchain.call?.functionName).toBe("revokeMandate");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sseEvents.some((e) => e.event === "mandate.revoked")).toBe(true);
    // New vouchers are refused at once.
    const res = await agentB.fetch(`${marketUrl}/quote?pair=after-revoke`);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MANDATE_REVOKED");
  });

  it("rejects unauthenticated admin calls and bad provider keys", async () => {
    expect((await api("GET", "/v1/overview", undefined, false)).status).toBe(401);
    const res = await fetch(`${node.url}/v1/vouchers`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    const health = await api("GET", "/healthz", undefined, false);
    expect(health.json).toMatchObject({ ok: true, chainId: 31337, hub, token, hspMode: "local" });
  });
});
