import { getAddress, type Address, type Hex } from "viem";
import { explorerTx, type Policy } from "@payminto/protocol";
import type { Database } from "./db/database.ts";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MandateRow = {
  id: Hex;
  owner: Address;
  agent: Address;
  token: Address;
  total_cap: string;
  valid_after: number;
  valid_until: number;
  payees_root: Hex;
  policy_hash: Hex;
  salt: Hex;
  owner_signature: Hex;
  policy: string;
  payees: string;
  label: string;
  status: "pending" | "open" | "revoked";
  open_tx_hash: Hex | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_tx_hash: Hex | null;
  created_at: string;
};

export type ProviderRow = {
  id: string;
  name: string;
  description: string;
  payee: Address;
  price_atomic: string;
  resource: string;
  category: string;
  api_key_hash: string;
  created_at: string;
};

export type CallRow = {
  seq: number;
  call_id: Hex;
  mandate_id: Hex;
  agent: Address;
  payee: Address;
  provider_id: string;
  amount: string;
  cumulative: string;
  request_hash: Hex;
  agent_signature: Hex;
  timestamp: number;
  leaf: Hex;
  node_signature: Hex;
  status: "accepted" | "settling" | "settled";
  batch_seq: number | null;
  proof: string | null;
  accepted_at: string;
};

export type DenialRow = {
  seq: number;
  id: string;
  rule: string;
  message: string;
  mandate_id: Hex;
  agent: Address | null;
  payee: Address;
  provider_id: string;
  amount: string;
  cumulative: string;
  request_hash: Hex;
  details: string;
  timestamp: number;
  at: string;
  /** How many identical denials this row stands for (migration 002). */
  repeats: number;
  last_seen: number | null;
};

export type BatchStatus = "building" | "cosigning" | "submitted" | "included" | "confirmed" | "failed";

export type BatchRow = {
  seq: number;
  batch_id: Hex;
  status: BatchStatus;
  token: Address;
  receipts_root: Hex | null;
  claims: number;
  calls: number;
  gross: string;
  net: string;
  transfers: number;
  projected_gross: string;
  projected_net: string;
  reconciled: number | null;
  tx_hash: Hex | null;
  block_number: number | null;
  gas_used: string | null;
  gas_price: string | null;
  error: string | null;
  trigger: string;
  created_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
  l1_fee: string | null;
  included_at: string | null;
  block_hash: Hex | null;
  tx_nonce: number | null;
  raw_tx: Hex | null;
  replacements: number;
  attestation_uid: Hex | null;
  attestation_tx: Hex | null;
};

export type BatchClaimRow = {
  batch_seq: number;
  idx: number;
  mandate_id: Hex;
  agent: Address;
  payee: Address;
  cumulative: string;
  previous: string;
  delta: string;
  calls: number;
  agent_signature: Hex;
  payee_proof: string;
};

export type NetTransferRow = {
  batch_seq: number;
  idx: number;
  from_addr: Address;
  to_addr: Address;
  amount: string;
  log_index: number | null;
};

/** PENDING = waiting for the debtor co-signature; COSIGNED = signed, not yet settled through HSP. */
export type HspStatus = "PENDING" | "COSIGNED" | "UNSIGNED" | "SUBMITTED" | "ACCEPT" | "REJECT" | "SETTLED" | "FAILED";

export type HspRow = {
  id: Hex;
  batch_seq: number;
  transfer_idx: number;
  payer: Address;
  recipient: Address;
  token: Address;
  amount: string;
  deadline: number;
  body: string;
  required_caps: string;
  calls: string;
  signer_proof: Hex | null;
  status: HspStatus;
  satisfied_caps: string | null;
  receipt: string | null;
  coordinator_id: string | null;
  coordinator_status: string | null;
  tx_hash: Hex | null;
  log_index: number | null;
  error: string | null;
  attempts: number;
  next_attempt_at: number | null;
  created_at: string;
  updated_at: string;
};

export type LedgerEntryRow = {
  id: number;
  journal_id: number;
  account: string;
  debit: string;
  credit: string;
  memo: string;
  at: string;
  kind: string;
  ref: string;
};

// ---------------------------------------------------------------------------
// API shapes (SPEC 5.6). Amounts are decimal strings of atomic units, addresses checksummed.
// ---------------------------------------------------------------------------

export function callJson(r: CallRow, batchId: Hex | null = null) {
  return {
    id: r.call_id,
    seq: r.seq,
    mandateId: r.mandate_id,
    agent: r.agent,
    payee: r.payee,
    providerId: r.provider_id,
    amount: r.amount,
    cumulative: r.cumulative,
    requestHash: r.request_hash,
    timestamp: r.timestamp,
    createdAt: r.accepted_at,
    status: r.status,
    batchId,
    leaf: r.leaf,
  };
}
export type CallJson = ReturnType<typeof callJson>;

export function denialJson(r: DenialRow) {
  return {
    id: r.id,
    rule: r.rule,
    message: r.message,
    mandateId: r.mandate_id,
    agent: r.agent,
    payee: r.payee,
    providerId: r.provider_id,
    amount: r.amount,
    cumulative: r.cumulative,
    requestHash: r.request_hash,
    details: JSON.parse(r.details) as Record<string, unknown>,
    timestamp: r.timestamp,
    createdAt: r.at,
    repeats: r.repeats,
    lastSeen: r.last_seen ?? r.timestamp,
  };
}
export type DenialJson = ReturnType<typeof denialJson>;

export function providerPublicJson(r: ProviderRow, calls24h: number) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    payee: r.payee,
    priceAtomic: r.price_atomic,
    resource: r.resource,
    category: r.category,
    calls24h,
  };
}

export function mandateStatus(r: MandateRow, nowSec: number): "pending" | "open" | "revoked" | "expired" {
  if (r.status === "open" && nowSec > r.valid_until) return "expired";
  return r.status;
}

export type Spend = { settled: string; pending: string; total: string; today: string; remaining: string };

export function mandateSummaryJson(
  r: MandateRow,
  spend: Spend,
  callCount: number,
  nowSec: number,
  funds: { balance: bigint; allowance: bigint } | null = null,
) {
  return {
    id: r.id,
    label: r.label,
    status: mandateStatus(r, nowSec),
    /** The signed on-chain mandate (MandateJson). */
    mandate: {
      owner: r.owner,
      agent: r.agent,
      token: r.token,
      totalCap: r.total_cap,
      validAfter: String(r.valid_after),
      validUntil: String(r.valid_until),
      payeesRoot: r.payees_root,
      policyHash: r.policy_hash,
      salt: r.salt,
    },
    owner: r.owner,
    agent: r.agent,
    token: r.token,
    totalCap: r.total_cap,
    expiresAt: new Date(r.valid_until * 1000).toISOString(),
    payees: JSON.parse(r.payees) as Address[],
    policy: JSON.parse(r.policy) as Policy,
    openTxHash: r.open_tx_hash,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    spend,
    calls: callCount,
    /** Last observed agent wallet balance and hub allowance (atomic units); null until first read. */
    agentBalance: funds ? funds.balance.toString() : null,
    agentAllowance: funds ? funds.allowance.toString() : null,
  };
}
export type MandateSummaryJson = ReturnType<typeof mandateSummaryJson>;

export function batchSummaryJson(r: BatchRow, chainId: number) {
  return {
    id: r.batch_id,
    seq: r.seq,
    status: r.status,
    token: r.token,
    receiptsRoot: r.receipts_root,
    claims: r.claims,
    calls: r.calls,
    transfers: r.transfers,
    gross: r.gross,
    net: r.net,
    projectedGross: r.projected_gross,
    projectedNet: r.projected_net,
    /** Calls per on-chain transfer for this batch; null until confirmed with at least one transfer. */
    compression: r.status === "confirmed" && r.transfers > 0 ? r.calls / r.transfers : null,
    reconciled: r.reconciled === null ? null : r.reconciled === 1,
    txHash: r.tx_hash,
    explorerUrl: r.tx_hash ? explorerTx(chainId, r.tx_hash) : null,
    blockNumber: r.block_number,
    gasUsed: r.gas_used,
    /** OP Stack L1 data fee paid by the settlement transaction (wei); null until included or off OP Stack chains. */
    l1Fee: r.l1_fee,
    /** Same-nonce fee bumps sent before the transaction was included. */
    replacements: r.replacements,
    error: r.error,
    trigger: r.trigger,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    /** One confirmation; `confirmedAt` follows once the block is at or below the configured finality head. */
    includedAt: r.included_at,
    confirmedAt: r.confirmed_at,
    /** EAS attestation of the confirmed batch, when EAS_ATTEST=true. */
    attestation: r.attestation_uid
      ? { uid: r.attestation_uid, txHash: r.attestation_tx, explorerUrl: r.attestation_tx ? explorerTx(chainId, r.attestation_tx) : null }
      : null,
  };
}
export type BatchSummaryJson = ReturnType<typeof batchSummaryJson>;

export function hspJson(r: HspRow, batchId: Hex) {
  return {
    paymentId: r.id,
    batchId,
    transferIndex: r.transfer_idx,
    payer: r.payer,
    recipient: r.recipient,
    token: r.token,
    amount: r.amount,
    deadline: r.deadline,
    status: r.status,
    cosigned: r.signer_proof !== null,
    /** Why the record is not (yet) ACCEPT/SETTLED, when known. */
    reason: r.error,
    requiredCapabilities: JSON.parse(r.required_caps) as string[],
    satisfiedCapabilities: r.satisfied_caps ? (JSON.parse(r.satisfied_caps) as string[]) : [],
    receipt: r.receipt ? (JSON.parse(r.receipt) as Record<string, unknown>) : null,
    coordinatorId: r.coordinator_id,
    coordinatorStatus: r.coordinator_status,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export type HspJson = ReturnType<typeof hspJson>;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const nowIso = () => new Date().toISOString();

export class Store {
  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  // meta
  getMeta(key: string): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  // mandates
  mandate(id: string): MandateRow | undefined {
    return this.db.get<MandateRow>("SELECT * FROM mandates WHERE id = ?", id.toLowerCase());
  }
  mandates(): MandateRow[] {
    return this.db.all<MandateRow>("SELECT * FROM mandates ORDER BY created_at DESC");
  }

  spendOf(m: MandateRow, nowSec: number): Spend {
    const pos = this.db.get<{ total: string; settled: string }>(
      "SELECT bigsum(cumulative) AS total, bigsum(settled) AS settled FROM positions WHERE mandate_id = ?",
      m.id,
    )!;
    const today = this.db.get<{ s: string }>(
      "SELECT bigsum(amount) AS s FROM calls WHERE mandate_id = ? AND timestamp > ?",
      m.id,
      nowSec - 86_400,
    )!.s;
    const total = BigInt(pos.total);
    const settled = BigInt(pos.settled);
    const cap = BigInt(m.total_cap);
    return {
      settled: settled.toString(),
      pending: (total - settled).toString(),
      total: total.toString(),
      today,
      remaining: (cap > total ? cap - total : 0n).toString(),
    };
  }

  callCount(mandateId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE mandate_id = ?", mandateId)!.n;
  }

  mandateSummary(m: MandateRow, nowSec: number): MandateSummaryJson {
    return mandateSummaryJson(m, this.spendOf(m, nowSec), this.callCount(m.id), nowSec, this.funds(m.agent, m.token));
  }

  /** Daily accepted spend for the last `days` days (UTC), oldest first. */
  spendSeries(mandateId: string, nowSec: number, days = 14): Array<{ day: string; amount: string; calls: number }> {
    const dayStart = Math.floor(nowSec / 86_400) * 86_400;
    const from = dayStart - (days - 1) * 86_400;
    const rows = this.db.all<{ d: number; amount: string; calls: number }>(
      "SELECT (timestamp / 86400) * 86400 AS d, bigsum(amount) AS amount, COUNT(*) AS calls FROM calls WHERE mandate_id = ? AND timestamp >= ? GROUP BY d",
      mandateId.toLowerCase(),
      from,
    );
    const byDay = new Map(rows.map((r) => [r.d, r]));
    return Array.from({ length: days }, (_, i) => {
      const d = from + i * 86_400;
      const r = byDay.get(d);
      return { day: new Date(d * 1000).toISOString().slice(0, 10), amount: r?.amount ?? "0", calls: r?.calls ?? 0 };
    });
  }

  /** Accepted spend per minute for the last `minutes` minutes, oldest first, so a live demo shows its curve. */
  spendRecent(mandateId: string, nowSec: number, minutes = 30): Array<{ at: string; amount: string; calls: number }> {
    const end = Math.floor(nowSec / 60) * 60;
    const from = end - (minutes - 1) * 60;
    const rows = this.db.all<{ m: number; amount: string; calls: number }>(
      "SELECT (timestamp / 60) * 60 AS m, bigsum(amount) AS amount, COUNT(*) AS calls FROM calls WHERE mandate_id = ? AND timestamp >= ? GROUP BY m",
      mandateId.toLowerCase(),
      from,
    );
    const byMinute = new Map(rows.map((r) => [r.m, r]));
    return Array.from({ length: minutes }, (_, i) => {
      const t = from + i * 60;
      const r = byMinute.get(t);
      return { at: new Date(t * 1000).toISOString(), amount: r?.amount ?? "0", calls: r?.calls ?? 0 };
    });
  }

  // providers
  provider(id: string): ProviderRow | undefined {
    return this.db.get<ProviderRow>("SELECT * FROM providers WHERE id = ?", id);
  }
  providerByKeyHash(hash: string): ProviderRow | undefined {
    return this.db.get<ProviderRow>("SELECT * FROM providers WHERE api_key_hash = ?", hash);
  }
  providers(): ProviderRow[] {
    return this.db.all<ProviderRow>("SELECT * FROM providers ORDER BY created_at, id");
  }
  providerCalls24h(id: string, nowSec: number): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE provider_id = ? AND timestamp > ?", id, nowSec - 86_400)!.n;
  }

  // positions
  position(mandateId: string, payee: Address): { cumulative: bigint; settled: bigint } {
    const r = this.db.get<{ cumulative: string; settled: string }>(
      "SELECT cumulative, settled FROM positions WHERE mandate_id = ? AND payee = ?",
      mandateId,
      payee,
    );
    return { cumulative: BigInt(r?.cumulative ?? "0"), settled: BigInt(r?.settled ?? "0") };
  }

  // calls
  call(callId: string): CallRow | undefined {
    return this.db.get<CallRow>("SELECT * FROM calls WHERE call_id = ?", callId.toLowerCase());
  }

  batchIdOfSeq(seq: number | null): Hex | null {
    if (seq === null) return null;
    return this.db.get<{ batch_id: Hex }>("SELECT batch_id FROM batches WHERE seq = ?", seq)?.batch_id ?? null;
  }

  callJsonOf(r: CallRow): CallJson {
    return callJson(r, this.batchIdOfSeq(r.batch_seq));
  }

  listCalls(f: { mandateId?: string; payee?: string; status?: string; providerId?: string; batchSeq?: number; limit: number; cursor?: number }): {
    items: CallJson[];
    nextCursor: string | null;
  } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (f.mandateId) (where.push("c.mandate_id = ?"), params.push(f.mandateId.toLowerCase()));
    if (f.payee) (where.push("c.payee = ?"), params.push(getAddress(f.payee)));
    if (f.status) (where.push("c.status = ?"), params.push(f.status));
    if (f.providerId) (where.push("c.provider_id = ?"), params.push(f.providerId));
    if (f.batchSeq !== undefined) (where.push("c.batch_seq = ?"), params.push(f.batchSeq));
    if (f.cursor !== undefined) (where.push("c.seq < ?"), params.push(f.cursor));
    const rows = this.db.all<CallRow & { b_id: Hex | null }>(
      `SELECT c.*, b.batch_id AS b_id FROM calls c LEFT JOIN batches b ON b.seq = c.batch_seq
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY c.seq DESC LIMIT ?`,
      ...params,
      f.limit + 1,
    );
    const page = rows.slice(0, f.limit);
    return {
      items: page.map((r) => callJson(r, r.b_id)),
      nextCursor: rows.length > f.limit && page.length ? String(page[page.length - 1]!.seq) : null,
    };
  }

  // denials
  listDenials(f: { limit: number; mandateId?: string }): DenialJson[] {
    const rows = f.mandateId
      ? this.db.all<DenialRow>("SELECT * FROM denials WHERE mandate_id = ? ORDER BY seq DESC LIMIT ?", f.mandateId.toLowerCase(), f.limit)
      : this.db.all<DenialRow>("SELECT * FROM denials ORDER BY seq DESC LIMIT ?", f.limit);
    return rows.map(denialJson);
  }

  // batches
  batch(idOrSeq: string): BatchRow | undefined {
    if (/^\d+$/.test(idOrSeq)) return this.db.get<BatchRow>("SELECT * FROM batches WHERE seq = ?", Number(idOrSeq));
    return this.db.get<BatchRow>("SELECT * FROM batches WHERE batch_id = ?", idOrSeq.toLowerCase());
  }
  batches(limit: number): BatchRow[] {
    return this.db.all<BatchRow>("SELECT * FROM batches ORDER BY seq DESC LIMIT ?", limit);
  }
  batchClaims(seq: number): BatchClaimRow[] {
    return this.db.all<BatchClaimRow>("SELECT * FROM batch_claims WHERE batch_seq = ? ORDER BY idx", seq);
  }
  netTransfers(seq: number): NetTransferRow[] {
    return this.db.all<NetTransferRow>("SELECT * FROM net_transfers WHERE batch_seq = ? ORDER BY idx", seq);
  }
  hspOfBatch(seq: number): HspRow[] {
    return this.db.all<HspRow>("SELECT * FROM hsp_payments WHERE batch_seq = ? ORDER BY transfer_idx", seq);
  }
  hsp(id: string): HspRow | undefined {
    return this.db.get<HspRow>("SELECT * FROM hsp_payments WHERE id = ?", id.toLowerCase());
  }
  hspJsonOf(r: HspRow): HspJson {
    return hspJson(r, this.batchIdOfSeq(r.batch_seq)!);
  }
  updateHsp(id: Hex, fields: Partial<Omit<HspRow, "id">>): HspRow {
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
    const values = keys.map((k) => fields[k] as string | number | null);
    this.db.run(`UPDATE hsp_payments SET ${sets} WHERE id = ?`, ...values, nowIso(), id);
    return this.hsp(id)!;
  }

  batchDetailJson(b: BatchRow, chainId: number) {
    const hsp = new Map(this.hspOfBatch(b.seq).map((h) => [h.transfer_idx, h]));
    return {
      ...batchSummaryJson(b, chainId),
      claimList: this.batchClaims(b.seq).map((c) => ({
        index: c.idx,
        mandateId: c.mandate_id,
        agent: c.agent,
        payee: c.payee,
        cumulative: c.cumulative,
        previous: c.previous,
        delta: c.delta,
        calls: c.calls,
      })),
      netTransfers: this.netTransfers(b.seq).map((t) => {
        const h = hsp.get(t.idx);
        return {
          index: t.idx,
          from: t.from_addr,
          to: t.to_addr,
          amount: t.amount,
          logIndex: t.log_index,
          hsp: h ? hspJson(h, b.batch_id) : null,
        };
      }),
      callList: this.listCalls({ batchSeq: b.seq, limit: 1000 }).items,
    };
  }
  updateBatch(seq: number, fields: Partial<Omit<BatchRow, "seq">>): void {
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    if (!keys.length) return;
    const values = keys.map((k) => fields[k] as string | number | null);
    this.db.run(`UPDATE batches SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE seq = ?`, ...values, seq);
  }

  // funds
  funds(address: Address, token: Address): { balance: bigint; allowance: bigint; refreshedAt: number } | null {
    const r = this.db.get<{ balance: string; allowance: string; refreshed_at: number }>(
      "SELECT balance, allowance, refreshed_at FROM wallet_funds WHERE address = ? AND token = ?",
      getAddress(address),
      getAddress(token),
    );
    return r ? { balance: BigInt(r.balance), allowance: BigInt(r.allowance), refreshedAt: r.refreshed_at } : null;
  }
  setFunds(address: Address, token: Address, balance: bigint, allowance: bigint): void {
    this.db.run(
      `INSERT INTO wallet_funds (address, token, balance, allowance, refreshed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (address, token) DO UPDATE SET balance = excluded.balance, allowance = excluded.allowance, refreshed_at = excluded.refreshed_at`,
      getAddress(address),
      getAddress(token),
      balance.toString(),
      allowance.toString(),
      Date.now(),
    );
  }

  /** Accepted-unsettled debits of an agent wallet across all its mandates in one token. */
  agentOutstanding(agent: Address, token: Address): bigint {
    const r = this.db.get<{ total: string; settled: string }>(
      `SELECT bigsum(p.cumulative) AS total, bigsum(p.settled) AS settled
       FROM positions p JOIN mandates m ON m.id = p.mandate_id WHERE m.agent = ? AND m.token = ?`,
      getAddress(agent),
      getAddress(token),
    )!;
    return BigInt(r.total) - BigInt(r.settled);
  }

  /** Agents with unsettled spend, for the funds refresher. */
  agentsWithOutstanding(token: Address): Address[] {
    return this.db
      .all<{ agent: Address }>(
        `SELECT DISTINCT m.agent AS agent FROM positions p JOIN mandates m ON m.id = p.mandate_id
         WHERE m.token = ? AND p.cumulative != p.settled`,
        getAddress(token),
      )
      .map((r) => r.agent);
  }

  unsettledCallCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE status = 'accepted'")!.n;
  }
}
