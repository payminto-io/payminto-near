import { explorerTx, type AccountId as Address, type Id32 as Hex, type Network, type Policy, type PublicKey, type Sig64 } from "@payminto/protocol";
import type { Database } from "./db/database.ts";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type BudgetRow = {
  id: Hex;
  owner: Address;
  /** The agent's ed25519 public key. */
  agent: PublicKey;
  settler: Address;
  cap: string;
  /** Unix milliseconds, as the hub stores it. */
  valid_until_ms: number;
  policy_hash: Hex;
  salt: Hex;
  policy: string;
  payees: string;
  label: string;
  status: "pending" | "open" | "revoked";
  open_tx_hash: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_tx_hash: string | null;
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
  budget_id: Hex;
  agent: PublicKey;
  payee: Address;
  provider_id: string;
  amount: string;
  cumulative: string;
  request_hash: Hex;
  agent_signature: Sig64;
  timestamp: number;
  /** `nodeDigest` of this call, which the node signed. Not a Merkle leaf: the leaf needs the batch id. */
  leaf: Hex;
  node_signature: Sig64;
  status: "accepted" | "settling" | "settled";
  batch_seq: number | null;
  proof: string | null;
  accepted_at: string;
  /** 0 for the first or only voucher of a request; later vouchers of a split request count up (migration 002). */
  request_part: number;
  /** Set when the payee settled this call itself on the hub (`settle_own`): settled, in no batch, with no Merkle proof. */
  seller_settlement_seq: number | null;
};

/** What a payee settled itself on the hub for one (Budget, payee) pair, as the node found and booked it (migration 003). */
export type SellerSettlementRow = {
  seq: number;
  id: string;
  budget_id: Hex;
  payee: Address;
  previous: string;
  cumulative: string;
  delta: string;
  uncleared: string;
  calls: number;
  detected_at: string;
};

export function sellerSettlementJson(r: SellerSettlementRow) {
  return {
    id: r.id,
    budgetId: r.budget_id,
    payee: r.payee,
    /** The settled position before and after, atomic units. */
    previous: r.previous,
    cumulative: r.cumulative,
    /** What the hub moved from the Budget's escrow to the payee's credit. */
    amount: r.delta,
    /** The part of `amount` above what this node had accepted: a voucher the agent signed that the node never cleared. */
    uncleared: r.uncleared,
    calls: r.calls,
  };
}
export type SellerSettlementJson = ReturnType<typeof sellerSettlementJson>;

/** How a settled call was settled: in one of this node's batches, or by its payee with `settle_own`. Null until settled. */
export type SettledBy = "batch" | "seller" | null;

export function settledByOf(r: Pick<CallRow, "status" | "seller_settlement_seq">): SettledBy {
  if (r.status !== "settled") return null;
  return r.seller_settlement_seq !== null ? "seller" : "batch";
}

export type DenialRow = {
  seq: number;
  id: string;
  rule: string;
  message: string;
  budget_id: Hex;
  agent: PublicKey | null;
  payee: Address;
  provider_id: string;
  amount: string;
  cumulative: string;
  request_hash: Hex;
  details: string;
  timestamp: number;
  at: string;
  /** How many identical denials this row stands for. */
  repeats: number;
  last_seen: number | null;
  /**
   * The refused voucher's signature by the Budget's agent key (migration 004). Null only on rows recorded before the
   * node checked the signature first: those are never signed or returned to an agent as the node's record.
   */
  agent_signature: Sig64 | null;
};

/** `unknown`: the send failed without a verdict; its calls are queued again and the batch is adopted if the hub has it. */
export type BatchStatus = "building" | "submitted" | "confirmed" | "failed" | "unknown";

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
  tx_hash: string | null;
  error: string | null;
  trigger: string;
  created_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
};

export type BatchClaimRow = {
  batch_seq: number;
  idx: number;
  budget_id: Hex;
  agent: PublicKey;
  payee: Address;
  cumulative: string;
  previous: string;
  delta: string;
  amount: string;
  request_hash: Hex;
  calls: number;
  agent_signature: Sig64;
};

export type BatchNetRow = { batch_seq: number; account: Address; debit: string; credit: string };

export type NetTransferRow = {
  batch_seq: number;
  idx: number;
  from_addr: Address;
  to_addr: Address;
  amount: string;
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
    budgetId: r.budget_id,
    agent: r.agent,
    payee: r.payee,
    providerId: r.provider_id,
    amount: r.amount,
    cumulative: r.cumulative,
    requestHash: r.request_hash,
    timestamp: r.timestamp,
    createdAt: r.accepted_at,
    status: r.status,
    /** "batch" or "seller" once settled. A call its payee settled itself has no batch and no Merkle proof. */
    settledBy: settledByOf(r),
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
    budgetId: r.budget_id,
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

export function budgetStatus(r: BudgetRow, nowSec: number): "pending" | "open" | "revoked" | "expired" {
  if (r.status === "open" && nowSec * 1000 > r.valid_until_ms) return "expired";
  return r.status;
}

export type Spend = { settled: string; pending: string; total: string; today: string; remaining: string };

export function budgetSummaryJson(
  r: BudgetRow,
  spend: Spend,
  callCount: number,
  nowSec: number,
  funds: { escrow: bigint; credit: bigint } | null = null,
) {
  return {
    id: r.id,
    label: r.label,
    status: budgetStatus(r, nowSec),
    /** The Budget terms as the hub hashes them. `validUntil` is Unix milliseconds. */
    budget: {
      owner: r.owner,
      agentPk: r.agent,
      settler: r.settler,
      cap: r.cap,
      validUntil: String(r.valid_until_ms),
      payees: JSON.parse(r.payees) as Address[],
      policyHash: r.policy_hash,
      salt: r.salt,
    },
    owner: r.owner,
    agent: r.agent,
    settler: r.settler,
    cap: r.cap,
    expiresAt: new Date(r.valid_until_ms).toISOString(),
    payees: JSON.parse(r.payees) as Address[],
    policy: JSON.parse(r.policy) as Policy,
    openTxHash: r.open_tx_hash,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    spend,
    calls: callCount,
    /** Last observed escrow, and the owner's withdrawable credit (atomic units); null until first read. */
    escrow: funds ? funds.escrow.toString() : null,
    ownerCredit: funds ? funds.credit.toString() : null,
  };
}
export type BudgetSummaryJson = ReturnType<typeof budgetSummaryJson>;

export function batchSummaryJson(r: BatchRow, network: Network) {
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
    explorerUrl: r.tx_hash ? explorerTx(network, r.tx_hash) : null,
    error: r.error,
    trigger: r.trigger,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    confirmedAt: r.confirmed_at,
  };
}
export type BatchSummaryJson = ReturnType<typeof batchSummaryJson>;


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

  // budgets
  budget(id: string): BudgetRow | undefined {
    return this.db.get<BudgetRow>("SELECT * FROM budgets WHERE id = ?", id.toLowerCase());
  }
  budgets(): BudgetRow[] {
    return this.db.all<BudgetRow>("SELECT * FROM budgets ORDER BY created_at DESC");
  }

  spendOf(m: BudgetRow, nowSec: number): Spend {
    const pos = this.db.get<{ total: string; settled: string }>(
      "SELECT bigsum(cumulative) AS total, bigsum(settled) AS settled FROM positions WHERE budget_id = ?",
      m.id,
    )!;
    const today = this.db.get<{ s: string }>(
      "SELECT bigsum(amount) AS s FROM calls WHERE budget_id = ? AND timestamp > ?",
      m.id,
      nowSec - 86_400,
    )!.s;
    const total = BigInt(pos.total);
    const settled = BigInt(pos.settled);
    const cap = BigInt(m.cap);
    return {
      settled: settled.toString(),
      pending: (total - settled).toString(),
      total: total.toString(),
      today,
      remaining: (cap > total ? cap - total : 0n).toString(),
    };
  }

  callCount(budgetId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE budget_id = ?", budgetId)!.n;
  }

  budgetSummary(m: BudgetRow, nowSec: number): BudgetSummaryJson {
    return budgetSummaryJson(m, this.spendOf(m, nowSec), this.callCount(m.id), nowSec, this.budgetFunds(m.id));
  }

  /** Daily accepted spend for the last `days` days (UTC), oldest first. */
  spendSeries(budgetId: string, nowSec: number, days = 14): Array<{ day: string; amount: string; calls: number }> {
    const dayStart = Math.floor(nowSec / 86_400) * 86_400;
    const from = dayStart - (days - 1) * 86_400;
    const rows = this.db.all<{ d: number; amount: string; calls: number }>(
      "SELECT (timestamp / 86400) * 86400 AS d, bigsum(amount) AS amount, COUNT(*) AS calls FROM calls WHERE budget_id = ? AND timestamp >= ? GROUP BY d",
      budgetId.toLowerCase(),
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
  spendRecent(budgetId: string, nowSec: number, minutes = 30): Array<{ at: string; amount: string; calls: number }> {
    const end = Math.floor(nowSec / 60) * 60;
    const from = end - (minutes - 1) * 60;
    const rows = this.db.all<{ m: number; amount: string; calls: number }>(
      "SELECT (timestamp / 60) * 60 AS m, bigsum(amount) AS amount, COUNT(*) AS calls FROM calls WHERE budget_id = ? AND timestamp >= ? GROUP BY m",
      budgetId.toLowerCase(),
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
  /** The paid services agents can call. The gateway's own rows (category `gateway`), which merchant payments clear against, are not services. */
  providers(): ProviderRow[] {
    return this.db.all<ProviderRow>("SELECT * FROM providers WHERE category <> 'gateway' ORDER BY created_at, id");
  }
  providerCalls24h(id: string, nowSec: number): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE provider_id = ? AND timestamp > ?", id, nowSec - 86_400)!.n;
  }

  // positions
  position(budgetId: string, payee: Address): { cumulative: bigint; settled: bigint } {
    const r = this.db.get<{ cumulative: string; settled: string }>(
      "SELECT cumulative, settled FROM positions WHERE budget_id = ? AND payee = ?",
      budgetId,
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

  listCalls(f: { budgetId?: string; payee?: string; status?: string; providerId?: string; batchSeq?: number; limit: number; cursor?: number }): {
    items: CallJson[];
    nextCursor: string | null;
  } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (f.budgetId) (where.push("c.budget_id = ?"), params.push(f.budgetId.toLowerCase()));
    if (f.payee) (where.push("c.payee = ?"), params.push(f.payee));
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
  listDenials(f: { limit: number; budgetId?: string }): DenialJson[] {
    const rows = f.budgetId
      ? this.db.all<DenialRow>("SELECT * FROM denials WHERE budget_id = ? ORDER BY seq DESC LIMIT ?", f.budgetId.toLowerCase(), f.limit)
      : this.db.all<DenialRow>("SELECT * FROM denials ORDER BY seq DESC LIMIT ?", f.limit);
    return rows.map(denialJson);
  }

  /**
   * The refusals of one request of a Budget that the node recorded for a voucher the agent signed, newest first.
   * What an agent reads to confirm a refusal a seller relayed.
   */
  refusalsOf(f: { budgetId: string; requestHash: string; payee?: string; cumulative?: string; limit: number }): DenialRow[] {
    const where = ["budget_id = ?", "request_hash = ?", "agent_signature IS NOT NULL"];
    const params: Array<string | number> = [f.budgetId.toLowerCase(), f.requestHash.toLowerCase()];
    if (f.payee !== undefined) (where.push("payee = ?"), params.push(f.payee));
    if (f.cumulative !== undefined) (where.push("cumulative = ?"), params.push(f.cumulative));
    return this.db.all<DenialRow>(`SELECT * FROM denials WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`, ...params, f.limit);
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
  batchNet(seq: number): BatchNetRow[] {
    return this.db.all<BatchNetRow>("SELECT * FROM batch_net WHERE batch_seq = ? ORDER BY account", seq);
  }
  netTransfers(seq: number): NetTransferRow[] {
    return this.db.all<NetTransferRow>("SELECT * FROM net_transfers WHERE batch_seq = ? ORDER BY idx", seq);
  }
  batchDetailJson(b: BatchRow, network: Network) {
    return {
      ...batchSummaryJson(b, network),
      claimList: this.batchClaims(b.seq).map((c) => ({
        index: c.idx,
        budgetId: c.budget_id,
        agent: c.agent,
        payee: c.payee,
        cumulative: c.cumulative,
        previous: c.previous,
        delta: c.delta,
        calls: c.calls,
      })),
      netTransfers: this.netTransfers(b.seq).map((t) => ({ index: t.idx, from: t.from_addr, to: t.to_addr, amount: t.amount })),
      net: this.batchNet(b.seq).map((n) => ({ account: n.account, debit: n.debit, credit: n.credit })),
      callList: this.listCalls({ batchSeq: b.seq, limit: 1000 }).items,
    };
  }
  updateBatch(seq: number, fields: Partial<Omit<BatchRow, "seq">>): void {
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    if (!keys.length) return;
    const values = keys.map((k) => fields[k] as string | number | null);
    this.db.run(`UPDATE batches SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE seq = ?`, ...values, seq);
  }

  // seller settlements
  sellerSettlement(seq: number): SellerSettlementRow | undefined {
    return this.db.get<SellerSettlementRow>("SELECT * FROM seller_settlements WHERE seq = ?", seq);
  }

  // funds
  budgetFunds(budgetId: string): { escrow: bigint; credit: bigint; refreshedAt: number } | null {
    const r = this.db.get<{ escrow: string; credit: string; refreshed_at: number }>("SELECT escrow, credit, refreshed_at FROM budget_funds WHERE budget_id = ?", budgetId);
    return r ? { escrow: BigInt(r.escrow), credit: BigInt(r.credit), refreshedAt: r.refreshed_at } : null;
  }
  setBudgetFunds(budgetId: string, escrow: bigint, credit: bigint, refreshedAtMs: number = Date.now()): void {
    this.db.run(
      `INSERT INTO budget_funds (budget_id, escrow, credit, refreshed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (budget_id) DO UPDATE SET escrow = excluded.escrow, credit = excluded.credit, refreshed_at = excluded.refreshed_at`,
      budgetId,
      escrow.toString(),
      credit.toString(),
      refreshedAtMs,
    );
  }

  /** Accepted-unsettled spending of one Budget: what its escrow must still cover. */
  budgetOutstanding(budgetId: string): bigint {
    const r = this.db.get<{ total: string; settled: string }>("SELECT bigsum(cumulative) AS total, bigsum(settled) AS settled FROM positions WHERE budget_id = ?", budgetId)!;
    return BigInt(r.total) - BigInt(r.settled);
  }

  /** Accepted-unsettled amounts payable to an account, from every Budget on this node. */
  incomingOutstanding(account: Address): bigint {
    const r = this.db.get<{ total: string; settled: string }>("SELECT bigsum(cumulative) AS total, bigsum(settled) AS settled FROM positions WHERE payee = ?", account)!;
    return BigInt(r.total) - BigInt(r.settled);
  }

  /** Budgets with unsettled spend, for the funds refresher. */
  budgetsWithOutstanding(): Array<Pick<BudgetRow, "id" | "owner">> {
    return this.db.all<Pick<BudgetRow, "id" | "owner">>(
      `SELECT DISTINCT m.id AS id, m.owner AS owner FROM positions p JOIN budgets m ON m.id = p.budget_id WHERE p.cumulative != p.settled`,
    );
  }

  unsettledCallCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE status = 'accepted'")!.n;
  }
}
