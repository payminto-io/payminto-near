import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  buildNetTransferMandate,
  clearingHubAbi,
  hspMandateFromWire,
  hspMandateToWire,
  hspPaymentId,
  hspTypes,
  isHspMandateSignedBy,
  payeeProof,
  receiptsTree,
  type CallReceipt,
  type HspWireMandate,
} from "@payminto/protocol";
import { ChainClient } from "./chain.ts";
import type { BatchAttester } from "./eas.ts";
import type { Database } from "./db/database.ts";
import { ApiError } from "./errors.ts";
import type { EventBus } from "./events.ts";
import type { FundsTracker } from "./funds.ts";
import type { HspPort } from "./hsp/port.ts";
import { errMessage } from "./hsp/port.ts";
import { accounts, type Ledger } from "./ledger.ts";
import type { Logger } from "./logger.ts";
import { grossGraph, netDebits, projectNetting, type NetTransfer } from "./netting.ts";
import { batchSummaryJson, nowIso, type BatchRow, type CallRow, type HspRow, type Store } from "./store.ts";

export const MAX_CLAIMS = 64;
const REVOKE_GRACE = 3_600n;
const EXPIRY_GRACE = 3n * 86_400n;
const HSP_DEADLINE_SEC = 3_600n;
const HSP_MAX_ATTEMPTS = 8;

/** One claim candidate: the latest accepted voucher of a (mandate, payee) pair above what is settled. */
export type Candidate = {
  mandateId: Hex;
  agent: Address;
  payee: Address;
  payees: Address[];
  cumulative: bigint;
  settled: bigint;
  delta: bigint;
  agentSig: Hex;
  calls: number;
};

export type SettleResult = { batchIds: Hex[]; batches: ReturnType<typeof batchSummaryJson>[]; dropped: DroppedClaim[] } | { skipped: string };
export type DroppedClaim = { mandateId: Hex; payee: Address; reason: string };

export function batchIdOf(chainId: number, hub: Address, receiptsRoot: Hex, seq: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
      [BigInt(chainId), hub, receiptsRoot, BigInt(seq)],
    ),
  );
}

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function toReceipt(c: CallRow): CallReceipt {
  return {
    callId: c.call_id,
    mandateId: c.mandate_id,
    payee: c.payee,
    amount: BigInt(c.amount),
    cumulative: BigInt(c.cumulative),
    requestHash: c.request_hash,
    timestamp: BigInt(c.timestamp),
  };
}

function sameTransfers(a: readonly NetTransfer[], b: readonly NetTransfer[]): boolean {
  return a.length === b.length && a.every((t, i) => isAddressEqual(t.from, b[i]!.from) && isAddressEqual(t.to, b[i]!.to) && t.amount === b[i]!.amount);
}


/** Consecutive finality ticks that must agree a batch was dropped before its calls return to the next batch. */
const DROPPED_STRIKES = 3;
export class SettlementService {
  readonly #db: Database;
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #ledger: Ledger;
  readonly #events: EventBus;
  readonly #funds: FundsTracker;
  readonly #hsp: HspPort;
  readonly #log: Logger;
  readonly #cosignTimeoutMs: number;
  readonly #attester: BatchAttester | null;
  /** Batches whose sender is still waiting for inclusion in this process; the finality tracker leaves them alone. */
  readonly #sending = new Set<number>();
  #tracking = false;
  /** Consecutive finality ticks on which a batch looked dropped with its nonce reused (see #handleMissing). */
  readonly #droppedStrikes = new Map<number, number>();
  #running: Promise<SettleResult> | null = null;
  readonly #cosignWaiters = new Map<number, () => void>();
  #hspRetrying = false;
  /** Run inside the transaction that books a confirmed batch (the gateway marks voucher payments paid there). */
  readonly confirmHooks: Array<(b: { seq: number; batchId: Hex; txHash: Hex; blockNumber: number }) => void> = [];

  constructor(deps: {
    db: Database;
    store: Store;
    chain: ChainClient;
    ledger: Ledger;
    events: EventBus;
    funds: FundsTracker;
    hsp: HspPort;
    log: Logger;
    cosignTimeoutSec: number;
    /** EAS_ATTEST=true: attests every confirmed batch before the HSP step. */
    attester?: BatchAttester | null;
  }) {
    this.#db = deps.db;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#ledger = deps.ledger;
    this.#events = deps.events;
    this.#funds = deps.funds;
    this.#hsp = deps.hsp;
    this.#log = deps.log.child({ component: "settlement" });
    this.#cosignTimeoutMs = deps.cosignTimeoutSec * 1000;
    this.#attester = deps.attester ?? null;
  }

  /** The HSP seam in use (local adapter or Coordinator), for /v1/info. */
  get hsp(): HspPort {
    return this.#hsp;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /** Resolves when the in-flight settlement (if any) finishes. */
  async idle(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  /** Latest accepted voucher per (mandate, payee) above the settled position, grouped by agent so netting stays in one chunk. */
  candidates(): Candidate[] {
    const rows = this.#db.all<{
      mandate_id: Hex;
      payee: Address;
      cumulative: string;
      settled: string;
      agent: Address;
      payees: string;
    }>(
      `SELECT p.mandate_id, p.payee, p.cumulative, p.settled, m.agent, m.payees
       FROM positions p JOIN mandates m ON m.id = p.mandate_id
       WHERE m.token = ? AND p.cumulative != p.settled
       ORDER BY m.agent, p.mandate_id, p.payee`,
      this.#chain.token,
    );
    const out: Candidate[] = [];
    for (const r of rows) {
      const last = this.#db.get<{ agent_signature: Hex }>(
        "SELECT agent_signature FROM calls WHERE mandate_id = ? AND payee = ? AND cumulative = ? AND status = 'accepted'",
        r.mandate_id,
        r.payee,
        r.cumulative,
      );
      if (!last) continue; // already in a batch that is being settled
      // A pair with calls in an unconfirmed batch waits: its on-chain settled position moves only when that batch lands.
      const inFlight = this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM calls WHERE mandate_id = ? AND payee = ? AND status = 'settling'",
        r.mandate_id,
        r.payee,
      )!.n;
      if (inFlight > 0) continue;
      const calls = this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM calls WHERE mandate_id = ? AND payee = ? AND status = 'accepted'",
        r.mandate_id,
        r.payee,
      )!.n;
      const cumulative = BigInt(r.cumulative);
      const settled = BigInt(r.settled);
      out.push({
        mandateId: r.mandate_id,
        agent: r.agent,
        payee: r.payee,
        payees: JSON.parse(r.payees) as Address[],
        cumulative,
        settled,
        delta: cumulative - settled,
        agentSig: last.agent_signature,
        calls,
      });
    }
    return out;
  }

  /** What settling now would do (GET /v1/netting/preview). Local data only, no chain reads. */
  preview() {
    const cands = this.candidates();
    const chunks = chunk(cands, MAX_CLAIMS).map((cs) => projectNetting(cs.map((c) => ({ agent: c.agent, payee: c.payee, delta: c.delta }))));
    const calls = cands.reduce((n, c) => n + c.calls, 0);
    const transfers = chunks.flatMap((p) => p.transfers);
    const grossTotal = cands.reduce((s, c) => s + c.delta, 0n);
    const netTotal = transfers.reduce((s, t) => s + t.amount, 0n);
    return {
      calls,
      claims: cands.length,
      batches: chunks.length,
      grossTotal: grossTotal.toString(),
      netTotal: netTotal.toString(),
      gross: grossGraph(cands.map((c) => ({ agent: c.agent, payee: c.payee, amount: c.delta, calls: c.calls }))).map((e) => ({
        ...e,
        amount: e.amount.toString(),
      })),
      net: transfers.map((t) => ({ from: t.from, to: t.to, amount: t.amount.toString() })),
      transfers: transfers.length,
      /** Calls per projected on-chain transfer; 0 when there is nothing to settle. */
      compression: transfers.length > 0 ? calls / transfers.length : 0,
      savedTransfers: Math.max(0, calls - transfers.length),
    };
  }

  /** Single-flight settlement of every accepted call. */
  settle(trigger: "manual" | "interval"): Promise<SettleResult> {
    if (this.#running) return Promise.resolve({ skipped: "a settlement is already running" });
    const run = this.#settle(trigger).finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  async #settle(trigger: "manual" | "interval"): Promise<SettleResult> {
    const chain = this.#chain;
    let cands = this.candidates();
    if (cands.length === 0) return { skipped: "nothing to settle" };
    const dropped: DroppedClaim[] = [];
    const drop = (c: Candidate, reason: string) => {
      dropped.push({ mandateId: c.mandateId, payee: c.payee, reason });
      cands = cands.filter((x) => x !== c);
    };

    // On-chain pre-checks: mandate settleable now, and our settled position equals the hub's.
    const block = await chain.public.getBlock();
    const now = block.timestamp;
    const mandateIds = [...new Set(cands.map((c) => c.mandateId))];
    const onchain = new Map(await Promise.all(mandateIds.map(async (id) => [id, await chain.mandate(id)] as const)));
    const settledOnchain = await Promise.all(cands.map((c) => chain.settledOf(c.mandateId, c.payee)));
    for (const [i, c] of [...cands.entries()]) {
      const m = onchain.get(c.mandateId);
      if (!m) {
        drop(c, "mandate is not open on chain");
        continue;
      }
      const byExpiry = m.validUntil + EXPIRY_GRACE;
      const deadline = m.revokedAt === 0n ? byExpiry : m.revokedAt + REVOKE_GRACE < byExpiry ? m.revokedAt + REVOKE_GRACE : byExpiry;
      if (now < m.validAfter || now > deadline) {
        drop(c, "mandate is outside its on-chain settlement window");
        continue;
      }
      if (!isAddressEqual(m.token, chain.token)) {
        drop(c, "mandate token differs from the settlement token");
        continue;
      }
      if (settledOnchain[i] !== c.settled) {
        drop(c, `on-chain settled ${settledOnchain[i]} differs from node position ${c.settled}`);
      }
    }
    await this.#screenBlacklist(cands, drop);
    for (const d of dropped) this.#funds.warn({ mandateId: d.mandateId, payee: d.payee, reason: d.reason });

    const batchIds: Hex[] = [];
    for (const group of chunk(cands, MAX_CLAIMS)) {
      const claims = await this.#fundedClaims(group, dropped);
      if (claims.length === 0) continue;
      const batchId = await this.#settleChunk(claims, trigger);
      if (batchId) batchIds.push(batchId);
    }
    if (batchIds.length === 0) return { skipped: dropped.length ? "no claim passed the on-chain pre-checks" : "nothing to settle" };
    return {
      batchIds,
      batches: batchIds.map((id) => batchSummaryJson(this.#store.batch(id)!, chain.chainId)),
      dropped,
    };
  }

  /**
   * FiatToken screening (USDC.e): a blacklisted sender or recipient makes transferFrom revert, which would revert the
   * whole netting batch. Every party is checked in one Multicall3 read; claims touching a blacklisted address are
   * dropped (all claims of a blacklisted agent's mandates, and every claim paying a blacklisted payee).
   */
  async #screenBlacklist(cands: Candidate[], drop: (c: Candidate, reason: string) => void): Promise<void> {
    if (cands.length === 0) return;
    const parties = cands.flatMap((c) => [c.agent, c.payee]);
    const black = await this.#chain.blacklisted(parties);
    if (black.size === 0) return;
    for (const c of [...cands]) {
      if (black.has(c.agent.toLowerCase())) drop(c, `agent ${c.agent} is blacklisted by the settlement token`);
      else if (black.has(c.payee.toLowerCase())) drop(c, `payee ${c.payee} is blacklisted by the settlement token`);
    }
    this.#log.warn("blacklisted parties left out of the batch", { parties: [...black] });
  }

  /** Drops every claim of an agent whose wallet cannot pay its projected net debit, until the projection is fundable. */
  async #fundedClaims(group: Candidate[], dropped: DroppedClaim[]): Promise<Candidate[]> {
    let claims = group;
    const checked = new Map<string, { balance: bigint; allowance: bigint }>();
    for (;;) {
      const projection = projectNetting(claims.map((c) => ({ agent: c.agent, payee: c.payee, delta: c.delta })));
      const short: Address[] = [];
      for (const [debtor, debit] of netDebits(projection)) {
        const key = debtor.toLowerCase();
        let f = checked.get(key);
        if (!f) {
          f = await this.#chain.funds(debtor);
          this.#store.setFunds(debtor, this.#chain.token, f.balance, f.allowance);
          checked.set(key, f);
        }
        if (f.balance < debit || f.allowance < debit) {
          short.push(debtor);
          this.#funds.warn({
            agent: debtor,
            reason: f.balance < debit ? "balance" : "allowance",
            required: debit.toString(),
            balance: f.balance.toString(),
            allowance: f.allowance.toString(),
          });
        }
      }
      if (short.length === 0) return claims;
      const isShort = (a: Address) => short.some((s) => isAddressEqual(s, a));
      for (const c of claims.filter((c) => isShort(c.agent))) {
        dropped.push({ mandateId: c.mandateId, payee: c.payee, reason: "agent cannot fund its net debit" });
      }
      claims = claims.filter((c) => !isShort(c.agent));
      if (claims.length === 0) return claims;
    }
  }

  async #settleChunk(claims: Candidate[], trigger: string): Promise<Hex | null> {
    const chain = this.#chain;
    const db = this.#db;
    const projection = projectNetting(claims.map((c) => ({ agent: c.agent, payee: c.payee, delta: c.delta })));

    // 1. Persist the batch: receipts tree over every call it clears, batch id, claims and projected transfers.
    const { seq, batchId, receiptsRoot } = db.tx(() => {
      const createdAt = nowIso();
      const { lastInsertRowid: seq } = db.run(
        "INSERT INTO batches (status, token, trigger, created_at) VALUES ('building', ?, ?, ?)",
        chain.token,
        trigger,
        createdAt,
      );
      const calls: CallRow[] = [];
      const perClaim: number[] = [];
      for (const c of claims) {
        const rows = db.all<CallRow>(
          `SELECT * FROM calls WHERE mandate_id = ? AND payee = ? AND status = 'accepted' ORDER BY seq`,
          c.mandateId,
          c.payee,
        ).filter((r) => BigInt(r.cumulative) <= c.cumulative && BigInt(r.cumulative) > c.settled);
        perClaim.push(rows.length);
        calls.push(...rows);
      }
      calls.sort((a, b) => a.seq - b.seq);
      const tree = receiptsTree(calls.map(toReceipt));
      const receiptsRoot = tree.root as Hex;
      const batchId = batchIdOf(chain.chainId, chain.hub, receiptsRoot, seq).toLowerCase() as Hex;
      this.#store.updateBatch(seq, {
        batch_id: batchId,
        receipts_root: receiptsRoot,
        claims: claims.length,
        calls: calls.length,
        projected_gross: projection.gross.toString(),
        projected_net: projection.net.toString(),
        transfers: projection.transfers.length,
      });
      const proofs = new Map<number, Hex[]>();
      for (const [i] of tree.entries()) proofs.set(i, tree.getProof(i) as Hex[]);
      calls.forEach((c, i) => {
        db.run(
          "UPDATE calls SET status = 'settling', batch_seq = ?, proof = ? WHERE seq = ?",
          seq,
          JSON.stringify(proofs.get(i) ?? []),
          c.seq,
        );
      });
      claims.forEach((c, i) => {
        db.run(
          `INSERT INTO batch_claims (batch_seq, idx, mandate_id, agent, payee, cumulative, previous, delta, calls, agent_signature, payee_proof)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          seq,
          i,
          c.mandateId,
          c.agent,
          c.payee,
          c.cumulative.toString(),
          c.settled.toString(),
          c.delta.toString(),
          perClaim[i]!,
          c.agentSig,
          JSON.stringify(c.payees.length ? payeeProof(c.payees, c.payee) : []),
        );
      });
      projection.transfers.forEach((t, i) => {
        db.run(
          "INSERT INTO net_transfers (batch_seq, idx, from_addr, to_addr, amount) VALUES (?, ?, ?, ?, ?)",
          seq,
          i,
          t.from,
          t.to,
          t.amount.toString(),
        );
      });
      this.#events.emit("batch.started", { batch: batchSummaryJson(this.#store.batch(String(seq))!, chain.chainId) });
      return { seq, batchId, receiptsRoot };
    });
    const log = this.#log.child({ batchId, seq });
    log.info("batch started", { claims: claims.length, transfers: projection.transfers.length });

    try {
      // 2. HSP co-sign phase: one HSP mandate per projected net transfer, bound to the batch id.
      await this.#cosignPhase(seq, batchId, projection.transfers);

      // 3. Simulate, then send.
      const args = [
        batchId,
        receiptsRoot,
        chain.token,
        claims.map((c) => ({
          voucher: { mandateId: c.mandateId, payee: c.payee, cumulative: c.cumulative },
          agentSig: c.agentSig,
          payeeProof: c.payees.length ? payeeProof(c.payees, c.payee) : [],
        })),
      ] as const;
      await chain.public.simulateContract({
        address: chain.hub,
        abi: clearingHubAbi,
        functionName: "settleBatch",
        args,
        account: chain.operator,
      });
      const data = encodeFunctionData({ abi: clearingHubAbi, functionName: "settleBatch", args });
      this.#sending.add(seq);
      let receipt: TransactionReceipt;
      try {
        receipt = await chain.send(
          { to: chain.hub, data },
          {
            // Persist every broadcast before waiting, so a restart or a reorg can find and rebroadcast it.
            onSent: (tx) =>
              db.tx(() => {
                const first = tx.replacement === 0;
                this.#store.updateBatch(seq, {
                  status: "submitted",
                  tx_hash: tx.hash,
                  raw_tx: tx.raw,
                  tx_nonce: tx.nonce,
                  replacements: tx.replacement,
                  ...(first ? { submitted_at: nowIso() } : {}),
                });
                this.#events.emit("batch.submitted", { batch: batchSummaryJson(this.#store.batch(String(seq))!, chain.chainId) });
                if (first) log.info("batch submitted", { txHash: tx.hash, nonce: tx.nonce });
                else log.warn("settlement not included yet; sent a same-nonce replacement with higher fees", { txHash: tx.hash, replacement: tx.replacement });
              }),
          },
        );
      } finally {
        this.#sending.delete(seq);
      }
      if (receipt.status !== "success") throw new Error(`settleBatch reverted in ${receipt.transactionHash}`);
      this.#markIncluded(seq, receipt);
      // CONFIRM_TAG=latest (anvil): one confirmation is final. Otherwise the finality tracker confirms it later.
      if (chain.confirmTag === "latest") await this.#finalize(seq, receipt);
      return batchId;
    } catch (err) {
      const row = this.#store.batch(String(seq))!;
      if (row.status === "confirmed" || row.status === "included") throw err;
      if (row.status === "submitted") {
        // Broadcast but not seen included (timeout or a nonce taken by another sender): leave it to the tracker,
        // which rebroadcasts or fails it safely. Never return its calls while the transaction may still be mined.
        this.#store.updateBatch(seq, { error: errMessage(err) });
        log.error("batch not included yet; the finality tracker keeps watching it", { err });
        return batchId;
      }
      this.#fail(seq, errMessage(err));
      log.error("batch failed", { err });
      return batchId;
    }
  }

  /** One confirmation: records block, gas and the L1 data fee. The ledger and HSP wait for finality. */
  #markIncluded(seq: number, receipt: TransactionReceipt): void {
    const l1 = ChainClient.l1FeeOf(receipt);
    this.#db.tx(() => {
      this.#store.updateBatch(seq, {
        status: "included",
        tx_hash: receipt.transactionHash,
        block_number: Number(receipt.blockNumber),
        block_hash: receipt.blockHash,
        gas_used: receipt.gasUsed.toString(),
        gas_price: receipt.effectiveGasPrice?.toString() ?? null,
        l1_fee: l1 === null ? null : l1.toString(),
        included_at: nowIso(),
        error: null,
      });
      this.#events.emit("batch.included", { batch: batchSummaryJson(this.#store.batch(String(seq))!, this.#chain.chainId) });
    });
    this.#log.info("batch included", { seq, txHash: receipt.transactionHash, block: receipt.blockNumber, confirmTag: this.#chain.confirmTag });
  }

  /**
   * Finality tracker (every block or so). Promotes included batches whose block is at or below the CONFIRM_TAG head,
   * follows a batch whose transaction moved to another block, and handles one that a reorg removed: its signed
   * transaction is rebroadcast with the same nonce; if that nonce now belongs to another transaction and the hub has
   * no record of the batch, the batch can never land, so it fails and its calls return to the next batch.
   * Also picks up submitted batches whose sender is gone (restart) and retries missing EAS attestations.
   */
  async trackFinality(): Promise<void> {
    if (this.#tracking) return;
    this.#tracking = true;
    try {
      const chain = this.#chain;
      const open = this.#db.all<BatchRow>("SELECT * FROM batches WHERE status IN ('submitted', 'included') ORDER BY seq");
      if (open.length === 0) return this.#retryAttestations();
      const head = await chain.headOf();
      for (const b of open) {
        if (this.#sending.has(b.seq) || !b.tx_hash) continue;
        const receipt = await chain.receiptOf(b.tx_hash);
        if (!receipt) {
          await this.#handleMissing(b);
          continue;
        }
        this.#droppedStrikes.delete(b.seq);
        if (receipt.status !== "success") {
          if (b.status === "submitted") this.#fail(b.seq, `settleBatch reverted in ${receipt.transactionHash}`);
          else this.#log.error("included settlement now reports a revert; waiting for the chain to settle down", { seq: b.seq });
          continue;
        }
        if (b.status === "submitted" || receipt.blockHash !== b.block_hash) this.#markIncluded(b.seq, receipt);
        if (receipt.blockNumber <= head) await this.#finalize(b.seq, receipt);
      }
      await this.#retryAttestations();
    } finally {
      this.#tracking = false;
    }
  }

  /** A submitted or included batch whose transaction the node no longer knows (reorged out, or dropped). */
  async #handleMissing(b: BatchRow): Promise<void> {
    const chain = this.#chain;
    const onchain = await chain.onchainBatch(b.batch_id);
    if (onchain.settledAt !== 0n) {
      this.#droppedStrikes.delete(b.seq);
      // The hub has the batch: an earlier broadcast or a replacement landed. Find it from the BatchSettled log.
      const hash = await this.#findSettlementTx(b.batch_id);
      if (hash) {
        const r = await chain.receiptOf(hash);
        if (r && r.status === "success") this.#markIncluded(b.seq, r);
      }
      return;
    }
    if (b.status === "included") {
      this.#db.tx(() => {
        this.#store.updateBatch(b.seq, { status: "submitted", block_number: null, block_hash: null, error: "reorged out; rebroadcasting the same transaction" });
        this.#events.emit("batch.submitted", { batch: batchSummaryJson(this.#store.batch(String(b.seq))!, chain.chainId) });
      });
      this.#log.warn("settlement transaction reorged out; rebroadcasting", { seq: b.seq, txHash: b.tx_hash });
    }
    if (!b.raw_tx) {
      this.#fail(b.seq, `transaction ${b.tx_hash} not found and no signed copy to rebroadcast`);
      return;
    }
    const outcome = await chain.rebroadcast(b.raw_tx);
    if (outcome === "nonce-used") {
      // Re-check the hub after the nonce answer: only a batch the hub does not know may return its calls. Public RPCs
      // are load-balanced, so one tick can combine a backend that has not seen the receipt or the batch with one that
      // is ahead on the nonce; the read is pinned to the newest block seen, and the batch fails only after
      // DROPPED_STRIKES consecutive ticks agree, because failing a batch that landed would pay its calls twice.
      const again = await chain.onchainBatch(b.batch_id, await chain.public.getBlockNumber({ cacheTime: 0 }));
      if (again.settledAt !== 0n) return void this.#droppedStrikes.delete(b.seq);
      const strikes = (this.#droppedStrikes.get(b.seq) ?? 0) + 1;
      this.#droppedStrikes.set(b.seq, strikes);
      if (strikes < DROPPED_STRIKES) {
        this.#log.warn("settlement transaction looks dropped with its nonce reused; checking again before failing it", { seq: b.seq, strikes });
        return;
      }
      this.#droppedStrikes.delete(b.seq);
      this.#fail(b.seq, `transaction ${b.tx_hash} was dropped and its nonce reused; the calls go into the next batch`);
    }
  }

  /** The transaction that emitted BatchSettled(batchId), searched in the last 5,000 blocks (the eth_getLogs limit). */
  async #findSettlementTx(batchId: Hex): Promise<Hex | null> {
    const chain = this.#chain;
    const latest = await chain.public.getBlockNumber();
    const logs = await chain.public.getLogs({
      address: chain.hub,
      event: clearingHubAbi.find((x) => x.type === "event" && x.name === "BatchSettled") as Extract<
        (typeof clearingHubAbi)[number],
        { type: "event"; name: "BatchSettled" }
      >,
      args: { batchId },
      fromBlock: latest > 5_000n ? latest - 5_000n : 0n,
      toBlock: latest,
    });
    return logs[0]?.transactionHash ?? null;
  }

  async #retryAttestations(): Promise<void> {
    if (!this.#attester) return;
    const rows = this.#db.all<BatchRow>("SELECT * FROM batches WHERE status = 'confirmed' AND attestation_uid IS NULL ORDER BY seq LIMIT 5");
    for (const b of rows) await this.#attest(b.seq);
  }

  /** EAS attestation of a confirmed batch. Failures are logged and retried; they never touch the ledger. */
  async #attest(seq: number): Promise<void> {
    if (!this.#attester) return;
    const b = this.#store.batch(String(seq))!;
    if (b.attestation_uid || b.status !== "confirmed") return;
    try {
      const a = await this.#attester.attest(this.#chain.hub, {
        batchId: b.batch_id,
        receiptsRoot: b.receipts_root!,
        gross: BigInt(b.gross),
        net: BigInt(b.net),
        transfers: BigInt(b.transfers),
      });
      this.#db.tx(() => {
        this.#store.updateBatch(seq, { attestation_uid: a.uid, attestation_tx: a.txHash });
        this.#events.emit("batch.confirmed", { batch: batchSummaryJson(this.#store.batch(String(seq))!, this.#chain.chainId) });
      });
      this.#log.info("batch attested on EAS", { seq, uid: a.uid, txHash: a.txHash });
    } catch (err) {
      this.#log.warn("EAS attestation failed; will retry", { seq, err });
    }
  }

  async #cosignPhase(seq: number, batchId: Hex, transfers: readonly NetTransfer[]): Promise<void> {
    const chain = this.#chain;
    const db = this.#db;
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + HSP_DEADLINE_SEC;
    db.tx(() => {
      this.#store.updateBatch(seq, { status: "cosigning" });
      transfers.forEach((t, i) => {
        const body = buildNetTransferMandate({
          payer: t.from,
          recipient: t.to,
          token: chain.token,
          amount: t.amount,
          chainId: chain.chainId,
          batchId,
          deadline,
          requiredCapabilities: this.#hsp.requiredCapabilities,
        });
        const id = hspPaymentId(chain.chainId, this.#hsp.verifyingContract, body).toLowerCase() as Hex;
        const calls = db
          .all<CallRow>("SELECT * FROM calls WHERE batch_seq = ? AND agent = ? ORDER BY seq", seq, t.from)
          .map((c) => ({ callId: c.call_id, mandateId: c.mandate_id, payee: c.payee, amount: c.amount, cumulative: c.cumulative }));
        const at = nowIso();
        db.run(
          `INSERT INTO hsp_payments (id, batch_seq, transfer_idx, payer, recipient, token, amount, deadline, body, required_caps, calls,
                                     status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
          id,
          seq,
          i,
          t.from,
          t.to,
          chain.token,
          t.amount.toString(),
          Number(deadline),
          JSON.stringify(hspMandateToWire(body)),
          JSON.stringify(this.#hsp.requiredCapabilities),
          JSON.stringify(calls),
          at,
          at,
        );
        this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(this.#store.hsp(id)!) });
      });
    });
    if (transfers.length > 0 && this.#cosignTimeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.#cosignTimeoutMs);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        const check = () => {
          const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM hsp_payments WHERE batch_seq = ? AND status = 'PENDING'", seq)!.n;
          if (n === 0) done();
        };
        this.#cosignWaiters.set(seq, check);
        check();
      });
      this.#cosignWaiters.delete(seq);
    }
    db.tx(() => {
      for (const h of this.#store.hspOfBatch(seq).filter((h) => h.status === "PENDING")) {
        const r = this.#store.updateHsp(h.id, { status: "UNSIGNED", error: "debtor did not co-sign before the batch was submitted" });
        this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(r) });
      }
    });
  }

  /** Pending HSP mandates for a debtor agent to co-sign (GET /v1/agents/:address/cosign). */
  pendingCosigns(address: Address) {
    const rows = this.#db.all<HspRow>(
      "SELECT * FROM hsp_payments WHERE payer = ? AND status = 'PENDING' ORDER BY created_at",
      getAddress(address),
    );
    return rows.map((r) => {
      const wire = JSON.parse(r.body) as HspWireMandate;
      return {
        hspPaymentId: r.id,
        batchId: this.#store.batchIdOfSeq(r.batch_seq)!,
        payer: r.payer,
        recipient: r.recipient,
        token: r.token,
        amount: r.amount,
        deadline: r.deadline,
        calls: JSON.parse(r.calls) as Array<{ callId: Hex; mandateId: Hex; payee: Address; amount: string; cumulative: string }>,
        typedData: {
          domain: { name: "HSP", version: "1", chainId: this.#chain.chainId, verifyingContract: this.#hsp.verifyingContract },
          types: hspTypes,
          primaryType: "Mandate" as const,
          message: wire,
        },
      };
    });
  }

  async cosign(id: string, signerProof: Hex) {
    const row = this.#store.hsp(id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "HSP payment not found");
    if (row.status !== "PENDING") {
      throw new ApiError(409, "COSIGN_CLOSED", `HSP payment is ${row.status}; co-signing is closed`, { status: row.status });
    }
    const body = hspMandateFromWire(JSON.parse(row.body) as HspWireMandate);
    const ok = await isHspMandateSignedBy(this.#chain.chainId, this.#hsp.verifyingContract, body, signerProof, row.payer);
    if (!ok) throw new ApiError(400, "BAD_COSIGN", "signerProof is not a valid signature by the payer over this HSP mandate");
    const updated = this.#db.tx(() => {
      const fresh = this.#store.hsp(id)!;
      if (fresh.status !== "PENDING") throw new ApiError(409, "COSIGN_CLOSED", `HSP payment is ${fresh.status}`);
      const r = this.#store.updateHsp(row.id, { status: "COSIGNED", signer_proof: signerProof, error: null });
      this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(r) });
      return r;
    });
    this.#cosignWaiters.get(row.batch_seq)?.();
    return this.#store.hspJsonOf(updated);
  }

  #fail(seq: number, error: string): void {
    this.#db.tx(() => {
      this.#store.updateBatch(seq, { status: "failed", error });
      this.#db.run("UPDATE calls SET status = 'accepted', batch_seq = NULL, proof = NULL WHERE batch_seq = ? AND status = 'settling'", seq);
      for (const h of this.#store.hspOfBatch(seq)) {
        const r = this.#store.updateHsp(h.id, { status: "FAILED", error: "batch failed; nothing was paid", next_attempt_at: null });
        this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(r) });
      }
      this.#events.emit("batch.failed", { batch: batchSummaryJson(this.#store.batch(String(seq))!, this.#chain.chainId) });
    });
  }

  /** Decodes the confirmed receipt, reconciles it with the projection, and books everything in one transaction. */
  async #finalize(seq: number, receipt: TransactionReceipt): Promise<void> {
    const chain = this.#chain;
    const db = this.#db;
    const batch = this.#store.batch(String(seq))!;
    const hubLogs = receipt.logs.filter((l) => isAddressEqual(l.address, chain.hub));
    const mine = <T extends { args: { batchId?: unknown } }>(xs: T[]) =>
      xs.filter((l) => String(l.args.batchId).toLowerCase() === batch.batch_id.toLowerCase());
    const vouchers = mine(parseEventLogs({ abi: clearingHubAbi, logs: hubLogs, eventName: "VoucherSettled" }));
    const nets = mine(parseEventLogs({ abi: clearingHubAbi, logs: hubLogs, eventName: "NetTransfer" }));
    const settledEv = mine(parseEventLogs({ abi: clearingHubAbi, logs: hubLogs, eventName: "BatchSettled" }))[0];
    if (!settledEv) throw new Error("BatchSettled event missing from receipt");

    const actual: Array<NetTransfer & { logIndex: number }> = nets.map((l) => ({
      from: getAddress(l.args.from as Address),
      to: getAddress(l.args.to as Address),
      amount: l.args.amount as bigint,
      logIndex: Number(l.logIndex),
    }));
    const projected = this.#store.netTransfers(seq).map((t) => ({ from: t.from_addr, to: t.to_addr, amount: BigInt(t.amount) }));
    const reconciled = sameTransfers(projected, actual);
    if (!reconciled) this.#log.error("netting projection does not match chain", { seq, projected, actual });
    const claims = this.#store.batchClaims(seq);
    const agentOf = new Map(claims.map((c) => [c.mandate_id.toLowerCase(), c.agent]));
    const knownAgents = new Set(
      this.#db.all<{ agent: string }>("SELECT DISTINCT agent FROM mandates").map((r) => r.agent.toLowerCase()),
    );
    const walletOf = (a: Address) => (knownAgents.has(a.toLowerCase()) ? accounts.agentWallet(a) : accounts.providerWallet(a));

    const booked = db.tx(() => {
      // Exactly once: the inline path (CONFIRM_TAG=latest) and the finality tracker can both get here.
      if (this.#store.batch(String(seq))!.status !== "included") return false;
      if (!reconciled) {
        db.run("DELETE FROM net_transfers WHERE batch_seq = ?", seq);
        actual.forEach((t, i) =>
          db.run(
            "INSERT INTO net_transfers (batch_seq, idx, from_addr, to_addr, amount, log_index) VALUES (?, ?, ?, ?, ?, ?)",
            seq,
            i,
            t.from,
            t.to,
            t.amount.toString(),
            t.logIndex,
          ),
        );
      } else {
        actual.forEach((t, i) => db.run("UPDATE net_transfers SET log_index = ? WHERE batch_seq = ? AND idx = ?", t.logIndex, seq, i));
      }
      this.#store.updateBatch(seq, {
        status: "confirmed",
        gross: (settledEv.args.gross as bigint).toString(),
        net: (settledEv.args.net as bigint).toString(),
        transfers: Number(settledEv.args.transfers as bigint),
        reconciled: reconciled ? 1 : 0,
        block_number: Number(receipt.blockNumber),
        confirmed_at: nowIso(),
        error: reconciled ? null : "on-chain net transfers differ from the projection; chain values recorded",
      });
      db.run("UPDATE calls SET status = 'settled' WHERE batch_seq = ?", seq);
      for (const c of claims) {
        db.run("UPDATE positions SET settled = ? WHERE mandate_id = ? AND payee = ?", c.cumulative, c.mandate_id, c.payee);
      }
      const postings = [
        ...vouchers.flatMap((v) => {
          const agent = agentOf.get(String(v.args.mandateId).toLowerCase());
          if (!agent) throw new Error(`VoucherSettled for unknown mandate ${String(v.args.mandateId)}`);
          const delta = v.args.delta as bigint;
          return [
            { account: accounts.agentPayable(agent), debit: delta, memo: "voucher settled" },
            { account: accounts.providerReceivable(v.args.payee as Address), credit: delta, memo: "voucher settled" },
          ];
        }),
        ...actual.flatMap((t) => [
          { account: walletOf(t.to), debit: t.amount, memo: "net transfer in" },
          { account: walletOf(t.from), credit: t.amount, memo: "net transfer out" },
        ]),
      ];
      this.#ledger.post("batch.settled", batch.batch_id, `batch ${seq}`, postings);
      for (const hook of this.confirmHooks) hook({ seq, batchId: batch.batch_id, txHash: receipt.transactionHash, blockNumber: Number(receipt.blockNumber) });
      for (const h of this.#store.hspOfBatch(seq)) {
        const lg = actual.find((t) => isAddressEqual(t.from, h.payer) && isAddressEqual(t.to, h.recipient) && t.amount === BigInt(h.amount));
        this.#store.updateHsp(h.id, { tx_hash: receipt.transactionHash, log_index: lg?.logIndex ?? null });
      }
      this.#events.emit("batch.confirmed", { batch: batchSummaryJson(this.#store.batch(String(seq))!, chain.chainId) });
      return true;
    });
    if (!booked) return;
    this.#log.info("batch confirmed", {
      seq,
      txHash: receipt.transactionHash,
      transfers: actual.length,
      gasUsed: receipt.gasUsed,
      l1Fee: ChainClient.l1FeeOf(receipt),
      confirmTag: chain.confirmTag,
      reconciled,
    });

    // Funds changed for every party; refresh in the background.
    const parties = new Set([...actual.flatMap((t) => [t.from, t.to])]);
    for (const p of parties) this.#funds.refresh(p).catch(() => undefined);

    // Optional EAS attestation, then the HSP step for each net transfer. Failures are recorded and retried;
    // they never touch the clearing ledger.
    await this.#attest(seq);
    await this.#runHsp(this.#store.hspOfBatch(seq).filter((h) => h.status === "COSIGNED" || h.status === "UNSIGNED"));
  }

  async #runHsp(rows: HspRow[]): Promise<void> {
    for (const h of rows) {
      const batch = this.#store.batch(String(h.batch_seq))!;
      if (!batch.tx_hash) continue;
      const outcome = await this.#hsp.settle({
        paymentId: h.id,
        body: hspMandateFromWire(JSON.parse(h.body) as HspWireMandate),
        signerProof: h.signer_proof,
        txHash: batch.tx_hash,
        batchId: batch.batch_id,
        coordinatorId: h.coordinator_id,
        attestationUid: batch.attestation_uid,
      });
      const attempts = h.attempts + 1;
      const retry = !!outcome.retry && attempts < HSP_MAX_ATTEMPTS;
      this.#db.tx(() => {
        const r = this.#store.updateHsp(h.id, {
          status: outcome.status,
          satisfied_caps: outcome.satisfied ? JSON.stringify(outcome.satisfied) : h.satisfied_caps,
          receipt: outcome.receipt ? JSON.stringify(outcome.receipt) : h.receipt,
          coordinator_id: outcome.coordinatorId ?? h.coordinator_id,
          coordinator_status: outcome.coordinatorStatus ?? h.coordinator_status,
          log_index: outcome.logIndex ?? h.log_index,
          error: outcome.error ?? (outcome.status === "UNSIGNED" ? h.error : null),
          attempts,
          next_attempt_at: retry ? Math.floor(Date.now() / 1000) + Math.min(600, 15 * 2 ** (attempts - 1)) : null,
        });
        this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(r) });
      });
      if (outcome.status === "REJECT" || outcome.status === "FAILED") {
        this.#log.warn("hsp payment not accepted", { hspPaymentId: h.id, status: outcome.status, error: outcome.error });
      }
    }
  }

  /** Background HSP retry worker: coordinator failures, and COSIGNED records left by a restart. */
  async retryHsp(): Promise<void> {
    if (this.#hspRetrying) return;
    this.#hspRetrying = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const rows = this.#db.all<HspRow>(
        `SELECT h.* FROM hsp_payments h JOIN batches b ON b.seq = h.batch_seq
         WHERE b.status = 'confirmed' AND (
           (h.status IN ('FAILED', 'SUBMITTED') AND h.next_attempt_at IS NOT NULL AND h.next_attempt_at <= ?)
           OR (h.status = 'COSIGNED' AND h.attempts = 0))
         ORDER BY h.created_at LIMIT 50`,
        now,
      );
      if (rows.length) await this.#runHsp(rows);
    } finally {
      this.#hspRetrying = false;
    }
  }

  /**
   * Startup recovery for batches interrupted by a crash or restart. Batches that never reached the chain fail and
   * return their calls; submitted and included ones are handed to the finality tracker, which finds their receipt,
   * rebroadcasts the stored signed transaction, or fails them only once they can no longer land.
   */
  async recover(): Promise<void> {
    const open = this.#db.all<BatchRow>("SELECT * FROM batches WHERE status IN ('building', 'cosigning') ORDER BY seq");
    for (const b of open) this.#fail(b.seq, "node restarted before the batch was submitted");
    try {
      await this.trackFinality();
    } catch (err) {
      this.#log.error("could not check in-flight batches at startup; the tracker retries", { err });
    }
  }
}
