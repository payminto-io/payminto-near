import type { Database } from "./db/database.ts";
import type { Network } from "@payminto/protocol";
import { batchSummaryJson, type BatchRow, type Store } from "./store.ts";

export function overview(db: Database, store: Store, network: Network, nowSec: number) {
  const day = nowSec - 86_400;
  const calls = db.get<{ total: number; last24h: number; pending: number; settled: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN timestamp > ? THEN 1 ELSE 0 END), 0) AS last24h,
            COALESCE(SUM(CASE WHEN status != 'settled' THEN 1 ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END), 0) AS settled
     FROM calls`,
    day,
  )!;
  const volume = db.get<{ settled: string; pending: string; last24h: string }>(
    `SELECT bigsum(CASE WHEN status = 'settled' THEN amount END) AS settled,
            bigsum(CASE WHEN status != 'settled' THEN amount END) AS pending,
            bigsum(CASE WHEN timestamp > ? THEN amount END) AS last24h
     FROM calls`,
    day,
  )!;
  const denials = db.get<{ total: number; last24h: number }>(
    "SELECT COALESCE(SUM(repeats), 0) AS total, COALESCE(SUM(CASE WHEN COALESCE(last_seen, timestamp) > ? THEN repeats ELSE 0 END), 0) AS last24h FROM denials",
    day,
  )!;
  const budgets = db.get<{ total: number; active: number }>(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'open' AND valid_until_ms >= ? THEN 1 ELSE 0 END), 0) AS active FROM budgets",
    nowSec * 1000,
  )!;
  const providers = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM providers")!.n;
  const batches = db.get<{ total: number; confirmed: number; failed: number; transfers: number; gross: string; net: string; settledCalls: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN transfers ELSE 0 END), 0) AS transfers,
            bigsum(CASE WHEN status = 'confirmed' THEN gross END) AS gross,
            bigsum(CASE WHEN status = 'confirmed' THEN net END) AS net,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN calls ELSE 0 END), 0) AS settledCalls
     FROM batches`,
  )!;
  const last = db.get<BatchRow>("SELECT * FROM batches ORDER BY seq DESC LIMIT 1");
  const bySeller = db.get<{ gross: string; calls: number; n: number }>("SELECT bigsum(delta) AS gross, COALESCE(SUM(calls), 0) AS calls, COUNT(*) AS n FROM seller_settlements")!;


  return {
    volume: { settled: volume.settled, pending: volume.pending, last24h: volume.last24h },
    calls: { all: calls.total, last24h: calls.last24h, pending: calls.pending, settled: calls.settled },
    denials24h: denials.last24h,
    denialsTotal: denials.total,
    activeBudgets: budgets.active,
    budgets: budgets.total,
    providers,
    batches: batches.total,
    batchesConfirmed: batches.confirmed,
    batchesFailed: batches.failed,
    transfers: batches.transfers,
    /** Gross cleared and net cash moved by confirmed batches. Offsetting is what makes net smaller than gross. */
    settled: { gross: batches.gross, net: batches.net },
    /** What payees settled themselves on the hub (`settle_own`), outside any batch: no offset, so gross is the cash moved. */
    settledBySeller: { gross: bySeller.gross, calls: bySeller.calls, settlements: bySeller.n },
    /** Settled calls per on-chain transfer; 0 before the first transfer. */
    compressionRatio: batches.transfers > 0 ? batches.settledCalls / batches.transfers : 0,
    lastBatch: last ? batchSummaryJson(last, network) : null,
    unsettledCalls: store.unsettledCallCount(),
  };
}
