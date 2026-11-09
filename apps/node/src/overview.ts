import type { Database } from "./db/database.ts";
import { batchSummaryJson, type BatchRow, type Store } from "./store.ts";

/**
 * Gas of one plain ERC-20 transfer to an existing holder, measured by `pnpm --filter @payminto/node gas`
 * (docs/GAS.md). The conservative per-call cost of paying one transfer per call, used for "gas saved".
 */
export const NAIVE_TRANSFER_GAS = 34_444n;

export function overview(db: Database, store: Store, chainId: number, nowSec: number) {
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
  const mandates = db.get<{ total: number; active: number }>(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'open' AND valid_until >= ? THEN 1 ELSE 0 END), 0) AS active FROM mandates",
    nowSec,
  )!;
  const providers = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM providers")!.n;
  const batches = db.get<{ total: number; confirmed: number; failed: number; transfers: number; gas: string; settledCalls: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN transfers ELSE 0 END), 0) AS transfers,
            bigsum(CASE WHEN status = 'confirmed' THEN gas_used END) AS gas,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN calls ELSE 0 END), 0) AS settledCalls
     FROM batches`,
  )!;
  const avgGasPrice = db.get<{ p: string; n: number }>(
    "SELECT bigsum(gas_price) AS p, COUNT(gas_price) AS n FROM batches WHERE status = 'confirmed'",
  )!;
  const last = db.get<BatchRow>("SELECT * FROM batches ORDER BY seq DESC LIMIT 1");

  const gasUsed = BigInt(batches.gas);
  const naiveGas = BigInt(batches.settledCalls) * NAIVE_TRANSFER_GAS;
  const gasSaved = naiveGas > gasUsed ? naiveGas - gasUsed : 0n;
  const gasPrice = avgGasPrice.n > 0 ? BigInt(avgGasPrice.p) / BigInt(avgGasPrice.n) : 0n;

  return {
    volume: { settled: volume.settled, pending: volume.pending, last24h: volume.last24h },
    calls: { all: calls.total, last24h: calls.last24h, pending: calls.pending, settled: calls.settled },
    denials24h: denials.last24h,
    denialsTotal: denials.total,
    activeMandates: mandates.active,
    mandates: mandates.total,
    providers,
    batches: batches.total,
    batchesConfirmed: batches.confirmed,
    batchesFailed: batches.failed,
    transfers: batches.transfers,
    /** Estimate versus one ERC-20 transfer per call (NAIVE_TRANSFER_GAS each). */
    gasSaved: {
      gas: gasSaved.toString(),
      native: avgGasPrice.n > 0 ? (gasSaved * gasPrice).toString() : null,
      used: gasUsed.toString(),
      naive: naiveGas.toString(),
      perTransferAssumption: NAIVE_TRANSFER_GAS.toString(),
    },
    /** Settled calls per on-chain transfer; 0 before the first transfer. */
    compressionRatio: batches.transfers > 0 ? batches.settledCalls / batches.transfers : 0,
    lastBatch: last ? batchSummaryJson(last, chainId) : null,
    unsettledCalls: store.unsettledCallCount(),
  };
}
