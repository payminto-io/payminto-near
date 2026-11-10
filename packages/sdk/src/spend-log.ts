import { REPEAT_WINDOW_SEC, type AccountId, type Id32, type Sig64 } from "@payminto/protocol";

/** One voucher this agent signed and sent, identified by the call id its node would give it. */
export type SignedVoucher = {
  payee: AccountId;
  amount: bigint;
  cumulative: bigint;
  requestHash: Id32;
  voucherSig: Sig64;
  callId: Id32;
  url: string;
};

type Entry = SignedVoucher & {
  /** Unix seconds: when the node accepted it, or when it was signed while its outcome is open. */
  at: number;
  /**
   * "accepted": the agent's node booked it and its receipt verified.
   * "outstanding": signed and sent, outcome unknown. The seller holds a voucher it can still collect, through the
   * node while the position still matches, or on the hub with `settle_own`.
   */
  state: "accepted" | "outstanding";
};

export type SpendTotals = { spentLastHour: bigint; spentLast24h: bigint; callsLastMinute: number; sameRequestCalls: number; sameRequestTimes: number[] };

const slot = (v: { payee: string; cumulative: bigint }) => `${v.payee}|${v.cumulative}`;

/**
 * What this agent spent and what it may still be made to spend, for the rolling windows of its policy guard.
 *
 * A voucher counts from the moment it leaves the process, not from the moment a receipt arrives: a seller that takes a
 * voucher and answers with an error, a forged receipt or a false refusal still holds something it can collect. So an
 * outstanding voucher counts in the hourly and daily amounts and in the repeat count for as long as it stays open,
 * whatever its age. It stops counting only when the agent's own node says what happened to it: booked (it becomes
 * accepted spend at that time) or passed over (the node moved to or past its cumulative with other vouchers, so it
 * can no longer be collected for more than the node already booked).
 *
 * Vouchers for one payee at one cumulative exclude each other in value: the node books at most one of them, and on the
 * hub they are all worth that same cumulative. They are counted once in the amounts, at the largest of them.
 */
export class SpendLog {
  readonly #entries = new Map<Id32, Entry>();

  get(callId: Id32): Entry | undefined {
    return this.#entries.get(callId);
  }

  /** Books a voucher as signed with its outcome open. Never downgrades one already accepted. */
  outstanding(v: SignedVoucher, at: number): void {
    if (this.#entries.get(v.callId)?.state === "accepted") return;
    this.#entries.delete(v.callId);
    this.#entries.set(v.callId, { ...v, at, state: "outstanding" });
  }

  /** Books a voucher as accepted by the agent's node at `at`. */
  accepted(v: SignedVoucher, at: number): void {
    this.#entries.delete(v.callId);
    this.#entries.set(v.callId, { ...v, at, state: "accepted" });
  }

  /** Forgets a voucher the agent's node passed over. */
  drop(callId: Id32): void {
    this.#entries.delete(callId);
  }

  /** Open vouchers for one payee, oldest first. */
  outstandingFor(payee: AccountId): SignedVoucher[] {
    return [...this.#entries.values()].filter((e) => e.state === "outstanding" && e.payee === payee);
  }

  /**
   * Drops what no window can see any more: accepted spend older than a day, and an open voucher that a newer one for
   * the same payee and cumulative replaced, once the repeat window has passed. The newest open voucher of each
   * (payee, cumulative) stays until the node resolves it.
   */
  prune(now: number): void {
    const newest = new Map<string, Id32>();
    for (const e of this.#entries.values()) if (e.state === "outstanding") newest.set(slot(e), e.callId);
    for (const e of this.#entries.values()) {
      if (e.state === "accepted" ? e.at <= now - 86_400 : newest.get(slot(e)) !== e.callId && e.at <= now - REPEAT_WINDOW_SEC) this.#entries.delete(e.callId);
    }
  }

  /**
   * The totals the guard holds the next voucher against. The voucher about to be signed is left out if it was sent
   * before (it is the same voucher), and so is whatever is open at its own payee and cumulative (it replaces that).
   */
  totals(now: number, next: { payee: AccountId; cumulative: bigint; requestHash: Id32; callId: Id32 }): SpendTotals {
    this.prune(now);
    let spentLastHour = 0n;
    let spentLast24h = 0n;
    let callsLastMinute = 0;
    const sameRequestTimes: number[] = [];
    const open = new Map<string, bigint>();
    for (const e of this.#entries.values()) {
      if (e.callId === next.callId && e.state === "outstanding") continue;
      if (e.at > now - 60) callsLastMinute++;
      if (e.state === "accepted") {
        if (e.at > now - 3_600) spentLastHour += e.amount;
        if (e.at > now - 86_400) spentLast24h += e.amount;
        if (e.requestHash === next.requestHash && e.at > now - REPEAT_WINDOW_SEC) sameRequestTimes.push(e.at);
        continue;
      }
      if (e.requestHash === next.requestHash) sameRequestTimes.push(e.at);
      const key = slot(e);
      if (key !== slot(next) && e.amount > (open.get(key) ?? 0n)) open.set(key, e.amount);
    }
    for (const amount of open.values()) {
      spentLastHour += amount;
      spentLast24h += amount;
    }
    sameRequestTimes.sort((a, b) => a - b);
    return { spentLastHour, spentLast24h, callsLastMinute, sameRequestCalls: sameRequestTimes.length, sameRequestTimes };
  }
}
