import { explorerTx, type AccountId, type Network } from "@payminto/protocol";
import type { Database } from "../db/database.ts";
import type { PayoutAccountRow } from "../payouts.ts";
import { DESTINATION_CHAINS } from "./intents.ts";
import type { MerchantRow } from "./merchants.ts";

/** How many payouts and any-chain deliveries one balance read lists, newest first. */
export const BALANCE_LIST_LIMIT = 50;
const DAY_SEC = 86_400;

export type MerchantBalance = {
  object: "merchant_balance";
  merchant_id: string;
  /** The NEAR account the hub credits; null until the business proves one. */
  payout: AccountId | null;
  network: Network;
  /**
   * Hub credit as the server last read it for its payout queue (`checked_at`), not a live read: a payment that just
   * landed shows on the hub before the next payout run reads it. `none` when the account was never queued.
   */
  credit: string;
  status: PayoutAccountRow["status"] | "none";
  checked_at: string | null;
  last_error: string | null;
  /** Credit inside a payout the server sent and has no verdict for yet. */
  in_flight: string;
  /** Paid out to the payout account in the last 30 days, read back from the hub after each payout. */
  paid_30d: string;
  paid_total: string;
  payouts: BalancePayout[];
  any_chain: { total: string; count: number; items: AnyChainDelivery[] };
};

export type BalancePayout = {
  seq: number;
  status: "submitted" | "confirmed" | "failed" | "unknown";
  outcome: "pending" | "paid" | "kept";
  /** What reached the account; 0 when the hub kept the credit. */
  amount: string;
  credit_before: string;
  tx_hash: string | null;
  explorer_url: string | null;
  at: string;
};

export type AnyChainDelivery = {
  quote_id: string;
  payment_id: string;
  amount: string;
  origin_chain: string;
  origin_symbol: string;
  recipient: AccountId;
  tx_hash: string | null;
  explorer_url: string | null;
  mode: "live" | "simulated";
  delivered_at: string;
};

type ItemRow = { seq: number; status: BalancePayout["status"]; tx_hash: string | null; created_at: string; finished_at: string | null; credit_before: string; paid: string; outcome: BalancePayout["outcome"] };
type QuoteRow = {
  id: string;
  payment_id: string;
  mode: "live" | "simulated";
  origin_chain: string;
  origin_symbol: string;
  recipient: AccountId;
  amount_out: string;
  delivered_amount: string | null;
  delivery_tx: string | null;
  delivered_unix: number | null;
  updated_at: string;
};

/**
 * `GET /v1/merchant/balance`: one business's money after the hub credited it, read from the server's own payout records
 * (payout_accounts, payouts, payout_items) for its current payout account, plus the any-chain payments 1Click delivered
 * to its NEAR account (confirmed quotes with a NEAR destination). Read only; never touches the chain.
 */
export function merchantBalance(db: Database, network: Network, m: MerchantRow, nowSec = Math.floor(Date.now() / 1000)): MerchantBalance {
  const account = m.payout;
  const row = account ? db.get<PayoutAccountRow>("SELECT * FROM payout_accounts WHERE account = ?", account) : undefined;
  const items = account
    ? db.all<ItemRow>(
        `SELECT p.seq, p.status, p.tx_hash, p.created_at, p.finished_at, i.credit_before, i.paid, i.outcome
         FROM payout_items i JOIN payouts p ON p.seq = i.payout_seq
         WHERE i.account = ? ORDER BY COALESCE(p.finished_at, p.created_at) DESC, p.seq DESC`,
        account,
      )
    : [];
  const since = new Date((nowSec - 30 * DAY_SEC) * 1000).toISOString();
  let inFlight = 0n;
  let paid30 = 0n;
  for (const i of items) {
    if (i.status === "submitted" && i.outcome === "pending") inFlight += BigInt(i.credit_before);
    if (i.outcome === "paid" && (i.finished_at ?? i.created_at) >= since) paid30 += BigInt(i.paid);
  }
  const payouts = items.slice(0, BALANCE_LIST_LIMIT).map(
    (i): BalancePayout => ({
      seq: i.seq,
      status: i.status,
      outcome: i.outcome,
      amount: i.outcome === "paid" ? i.paid : "0",
      credit_before: i.credit_before,
      tx_hash: i.tx_hash,
      explorer_url: i.tx_hash ? explorerTx(network, i.tx_hash) : null,
      at: i.finished_at ?? i.created_at,
    }),
  );

  const quotes = db.all<QuoteRow>(
    `SELECT id, payment_id, mode, origin_chain, origin_symbol, recipient, amount_out, delivered_amount, delivery_tx, delivered_unix, updated_at
     FROM intents_quotes WHERE merchant_id = ? AND status = 'confirmed' AND destination_chain = 'near'
     ORDER BY COALESCE(delivered_unix, 0) DESC, updated_at DESC, id DESC`,
    m.id,
  );
  let anyTotal = 0n;
  const deliveries = quotes.map((q): AnyChainDelivery => {
    const amount = q.delivered_amount ?? q.amount_out;
    anyTotal += BigInt(amount);
    const hash = q.delivery_tx;
    const base = DESTINATION_CHAINS.near?.explorer ?? null;
    return {
      quote_id: q.id,
      payment_id: q.payment_id,
      amount,
      origin_chain: q.origin_chain,
      origin_symbol: q.origin_symbol,
      recipient: q.recipient,
      tx_hash: hash,
      // A simulated delivery never touched a chain, so it has no explorer page.
      explorer_url: hash && q.mode === "live" && base ? `${base}${hash}` : null,
      mode: q.mode,
      delivered_at: q.delivered_unix ? new Date(q.delivered_unix * 1000).toISOString() : q.updated_at,
    };
  });

  return {
    object: "merchant_balance",
    merchant_id: m.id,
    payout: account,
    network,
    credit: row?.credit ?? "0",
    status: row?.status ?? "none",
    checked_at: row?.checked_at ?? null,
    last_error: row && row.status !== "clear" ? row.last_error : null,
    in_flight: inFlight.toString(),
    paid_30d: paid30.toString(),
    paid_total: row?.paid_total ?? "0",
    payouts,
    any_chain: { total: anyTotal.toString(), count: deliveries.length, items: deliveries.slice(0, BALANCE_LIST_LIMIT) },
  };
}

/** One business-month of platform fees: payments that reached paid or overpaid, by the UTC month they were paid in. */
export type FeeMonth = { month: string; merchant_id: string; merchant_name: string; payments: number; volume: string; platform_fee: string; method_fee: string; fee_total: string };

/** `GET /v1/platform/fees/months`: every month the platform earned in, by business, newest month first. */
export function feesByMonth(db: Database): { object: "platform_fee_months"; items: FeeMonth[] } {
  const items = db.all<FeeMonth>(
    `SELECT substr(p.paid_at, 1, 7) AS month, p.merchant_id, m.name AS merchant_name, COUNT(*) AS payments,
            bigsum(p.amount_paid) AS volume, bigsum(p.platform_fee) AS platform_fee, bigsum(p.method_fee) AS method_fee, bigsum(p.fee_total) AS fee_total
     FROM payments p JOIN merchants m ON m.id = p.merchant_id
     WHERE p.status IN ('paid', 'overpaid') AND p.paid_at IS NOT NULL
     GROUP BY month, p.merchant_id
     ORDER BY month DESC, m.name, p.merchant_id`,
  );
  return { object: "platform_fee_months", items };
}
