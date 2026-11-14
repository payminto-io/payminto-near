/**
 * A business's Balance: what the hub owes it and what reached it. Pure, so the totals are unit tested.
 */
import type { MerchantBalance } from "./platform-schemas";
import type { Payouts } from "./schemas";

const DAY_MS = 86_400_000;

/** The Balance of one business as the demo can tell it: its payout account's row and payouts in `GET /v1/payouts`. */
export function balanceFromPayouts(merchantId: string, payout: string | null, network: string, p: Payouts, now = Date.now()): MerchantBalance {
  const row = payout ? p.accounts.find((a) => a.account === payout) : undefined;
  const since = new Date(now - 30 * DAY_MS).toISOString();
  let inFlight = 0n;
  let paid30 = 0n;
  const payouts: MerchantBalance["payouts"] = [];
  for (const run of p.payouts) {
    const item = run.items.find((i) => i.account === payout);
    if (!item) continue;
    const at = run.finishedAt ?? run.createdAt;
    if (run.status === "submitted" && item.outcome === "pending") inFlight += BigInt(item.creditBefore);
    if (item.outcome === "paid" && at >= since) paid30 += BigInt(item.paid);
    payouts.push({ seq: run.seq, status: run.status, outcome: item.outcome, amount: item.outcome === "paid" ? item.paid : "0", credit_before: item.creditBefore, tx_hash: run.txHash ?? null, explorer_url: run.explorerUrl ?? null, at });
  }
  payouts.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.seq - a.seq));
  return {
    object: "merchant_balance",
    merchant_id: merchantId,
    payout,
    network,
    credit: row?.credit ?? "0",
    status: row?.status ?? "none",
    checked_at: row?.checkedAt ?? null,
    last_error: row && row.status !== "clear" ? (row.lastError ?? null) : null,
    in_flight: inFlight.toString(),
    paid_30d: paid30.toString(),
    paid_total: row?.paidTotal ?? "0",
    payouts,
    any_chain: { total: "0", count: 0, items: [] },
  };
}

export type BalanceTotals = { waiting: string; inFlight: string; paid30d: string; source: "hub" | "server" };

/**
 * The three figures at the top of Balance. `hubCredit` is the hub's credit as this browser read it (null when it could
 * not): the hub zeroes credit when a payout starts, so it never holds money in flight. The server's own copy is from its
 * last payout run and still holds what it is paying out, so that part is taken off.
 */
export function balanceTotals(b: MerchantBalance, hubCredit: string | null): BalanceTotals {
  const inFlight = BigInt(b.in_flight);
  if (hubCredit !== null) return { waiting: hubCredit, inFlight: b.in_flight, paid30d: b.paid_30d, source: "hub" };
  const left = BigInt(b.credit) - inFlight;
  return { waiting: (left > 0n ? left : 0n).toString(), inFlight: b.in_flight, paid30d: b.paid_30d, source: "server" };
}
