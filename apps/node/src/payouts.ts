import { ChainError, explorerTx, MAX_PAYOUT_ACCOUNTS, type AccountId, type Network } from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";
import type { Database } from "./db/database.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logger.ts";
import { Mutex } from "./mutex.ts";
import { chunk } from "./settlement.ts";
import { nowIso } from "./store.ts";

export type PayoutAccountRow = {
  account: AccountId;
  status: "due" | "waiting_registration" | "clear";
  credit: string;
  attempts: number;
  next_attempt_unix: number;
  last_error: string | null;
  checked_at: string | null;
  paid_total: string;
  updated_at: string;
};

export type PayoutRow = {
  seq: number;
  status: "submitted" | "confirmed" | "failed" | "unknown";
  trigger: string;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type PayoutItemRow = {
  payout_seq: number;
  account: AccountId;
  credit_before: string;
  credit_after: string | null;
  paid: string;
  outcome: "pending" | "paid" | "kept";
};

export type PayoutRunResult = { payouts: ReturnType<PayoutService["payoutJson"]>[]; waitingRegistration: AccountId[] } | { skipped: string };

/** An unregistered account is checked again after this long: registering is the account holder's own transaction. */
const REGISTRATION_RECHECK_SEC = 600;
/** Backoff after a payout that did not pay: 1, 2, 4 ... minutes, at most an hour. */
export const payoutBackoffSec = (attempts: number): number => Math.min(3_600, 60 * 2 ** Math.max(0, attempts - 1));

/**
 * Pays out hub credit to the node's creditors: net creditors of its batches and merchants paid through checkout. Runs on
 * an interval and on demand, in calls of at most MAX_PAYOUT_ACCOUNTS, under the same write lock as settlement.
 *
 * The hub's `payout` zeroes an account's credit before the transfer and restores it if the transfer fails, and skips
 * accounts not registered with the token, so a payout is safe to repeat and nothing here can pay twice. What was paid is
 * read back from the hub: credit before the call minus credit after it. An account without token registration waits
 * (its credit stays on the hub), and a restored credit is retried with backoff.
 */
export class PayoutService {
  readonly #db: Database;
  readonly #chain: ChainClient;
  readonly #events: EventBus;
  readonly #log: Logger;
  readonly #writes: Mutex;
  readonly #clock: () => number;
  #running: Promise<PayoutRunResult> | null = null;

  constructor(o: { db: Database; chain: ChainClient; events: EventBus; log: Logger; writes?: Mutex; clock?: () => number }) {
    this.#db = o.db;
    this.#chain = o.chain;
    this.#events = o.events;
    this.#log = o.log.child({ component: "payouts" });
    this.#writes = o.writes ?? new Mutex();
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  get network(): Network {
    return this.#chain.network;
  }

  /** Queues an account for the next payout. Joins the caller's transaction (a confirmed batch, a recorded checkout payment). */
  enqueue(account: AccountId): void {
    this.#db.run(
      `INSERT INTO payout_accounts (account, status, next_attempt_unix, updated_at) VALUES (?, 'due', 0, ?)
       ON CONFLICT (account) DO UPDATE SET status = 'due', next_attempt_unix = 0, attempts = 0, last_error = NULL, updated_at = excluded.updated_at`,
      account,
      nowIso(),
    );
  }

  async idle(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  /** Single flight: a run while one is going returns `skipped`. */
  run(trigger: "manual" | "interval"): Promise<PayoutRunResult> {
    if (this.#running) return Promise.resolve({ skipped: "a payout is already running" });
    const run = this.#run(trigger).finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  async #run(trigger: string): Promise<PayoutRunResult> {
    const now = this.#clock();
    const due = this.#db.all<PayoutAccountRow>(
      "SELECT * FROM payout_accounts WHERE status IN ('due', 'waiting_registration') AND next_attempt_unix <= ? ORDER BY account",
      now,
    );
    if (due.length === 0) return { skipped: "no account is due" };
    const chain = this.#chain.chain;
    const ready: Array<{ account: AccountId; credit: bigint }> = [];
    const waiting: AccountId[] = [];
    for (const r of due) {
      let credit: bigint;
      let registered: boolean;
      try {
        [credit, registered] = await Promise.all([chain.creditOf(r.account), chain.isRegistered(r.account)]);
      } catch (err) {
        this.#log.warn("cannot read a payout account from the hub; asking again on the next run", { account: r.account, err });
        continue;
      }
      if (credit === 0n) this.#setAccount(r.account, { status: "clear", credit: 0n, attempts: 0, next: 0, error: null });
      else if (!registered) {
        waiting.push(r.account);
        this.#setAccount(r.account, { status: "waiting_registration", credit, attempts: r.attempts, next: now + REGISTRATION_RECHECK_SEC, error: "the account is not registered with the token; its credit stays on the hub until it registers" });
      } else ready.push({ account: r.account, credit });
    }
    const payouts: ReturnType<PayoutService["payoutJson"]>[] = [];
    for (const group of chunk(ready, MAX_PAYOUT_ACCOUNTS)) payouts.push(this.payoutJson(await this.#pay(group, trigger)));
    return { payouts, waitingRegistration: waiting };
  }

  async #pay(group: Array<{ account: AccountId; credit: bigint }>, trigger: string): Promise<PayoutRow> {
    const db = this.#db;
    const seq = db.tx(() => {
      const { lastInsertRowid } = db.run("INSERT INTO payouts (status, trigger, created_at) VALUES ('submitted', ?, ?)", trigger, nowIso());
      for (const g of group) db.run("INSERT INTO payout_items (payout_seq, account, credit_before, outcome) VALUES (?, ?, ?, 'pending')", lastInsertRowid, g.account, g.credit.toString());
      return lastInsertRowid;
    });
    const accounts = group.map((g) => g.account);
    let txHash: string;
    try {
      txHash = await this.#writes.run(() => this.#chain.chain.payout(accounts));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A refusal pays nobody. Without a verdict the hub may have paid: the next run reads credit again and pays the rest.
      this.#finish(seq, err instanceof ChainError ? "failed" : "unknown", null, message);
      for (const g of group) this.#retryLater(g.account, g.credit, message);
      this.#log.warn("payout did not complete", { seq, err });
      return this.#payout(seq);
    }
    const after = await Promise.all(accounts.map((a) => this.#chain.chain.creditOf(a).catch(() => null)));
    db.tx(() => {
      group.forEach((g, i) => {
        const left = after[i];
        if (left === null || left === undefined) {
          // Paid or not, the next run reads it again.
          db.run("UPDATE payout_items SET outcome = 'kept' WHERE payout_seq = ? AND account = ?", seq, g.account);
          this.#retryLater(g.account, g.credit, "credit could not be read after the payout");
          return;
        }
        const paid = left < g.credit ? g.credit - left : 0n;
        db.run(
          "UPDATE payout_items SET credit_after = ?, paid = ?, outcome = ? WHERE payout_seq = ? AND account = ?",
          left.toString(),
          paid.toString(),
          paid > 0n ? "paid" : "kept",
          seq,
          g.account,
        );
        if (paid > 0n) {
          db.run("UPDATE payout_accounts SET paid_total = ? WHERE account = ?", (BigInt(this.account(g.account)?.paid_total ?? "0") + paid).toString(), g.account);
        }
        if (left === 0n) this.#setAccount(g.account, { status: "clear", credit: 0n, attempts: 0, next: 0, error: null });
        else if (paid > 0n) this.#setAccount(g.account, { status: "due", credit: left, attempts: 0, next: 0, error: null });
        else this.#retryLater(g.account, left, "the hub kept the credit: the token transfer failed and was restored");
      });
      this.#finish(seq, "confirmed", txHash, null);
    });
    return this.#payout(seq);
  }

  #retryLater(account: AccountId, credit: bigint, error: string): void {
    const attempts = (this.account(account)?.attempts ?? 0) + 1;
    this.#setAccount(account, { status: "due", credit, attempts, next: this.#clock() + payoutBackoffSec(attempts), error });
  }

  #setAccount(account: AccountId, s: { status: PayoutAccountRow["status"]; credit: bigint; attempts: number; next: number; error: string | null }): void {
    this.#db.run(
      `UPDATE payout_accounts SET status = ?, credit = ?, attempts = ?, next_attempt_unix = ?, last_error = ?, checked_at = ?, updated_at = ? WHERE account = ?`,
      s.status,
      s.credit.toString(),
      s.attempts,
      s.next,
      s.error,
      nowIso(),
      nowIso(),
      account,
    );
  }

  #finish(seq: number, status: PayoutRow["status"], txHash: string | null, error: string | null): void {
    this.#db.tx(() => {
      if (status !== "confirmed") this.#db.run("UPDATE payout_items SET outcome = 'kept' WHERE payout_seq = ? AND outcome = 'pending'", seq);
      this.#db.run("UPDATE payouts SET status = ?, tx_hash = ?, error = ?, finished_at = ? WHERE seq = ?", status, txHash, error, nowIso(), seq);
      this.#events.emit(status === "confirmed" ? "payout.confirmed" : "payout.failed", { payout: this.payoutJson(this.#payout(seq)) });
    });
  }

  #payout(seq: number): PayoutRow {
    return this.#db.get<PayoutRow>("SELECT * FROM payouts WHERE seq = ?", seq)!;
  }

  account(account: AccountId): PayoutAccountRow | undefined {
    return this.#db.get<PayoutAccountRow>("SELECT * FROM payout_accounts WHERE account = ?", account);
  }

  /** At startup: a payout a crash left in flight has no verdict; its accounts stay due and the next run reads credit again. */
  recover(): void {
    for (const p of this.#db.all<PayoutRow>("SELECT * FROM payouts WHERE status = 'submitted'")) {
      this.#finish(p.seq, "unknown", null, "the node stopped while this payout was in flight");
    }
  }

  payoutJson(p: PayoutRow) {
    const items = this.#db.all<PayoutItemRow>("SELECT * FROM payout_items WHERE payout_seq = ? ORDER BY account", p.seq);
    return {
      seq: p.seq,
      status: p.status,
      trigger: p.trigger,
      txHash: p.tx_hash,
      explorerUrl: p.tx_hash ? explorerTx(this.#chain.network, p.tx_hash) : null,
      error: p.error,
      createdAt: p.created_at,
      finishedAt: p.finished_at,
      items: items.map((i) => ({ account: i.account, creditBefore: i.credit_before, creditAfter: i.credit_after, paid: i.paid, outcome: i.outcome })),
    };
  }

  accountJson(r: PayoutAccountRow) {
    return {
      account: r.account,
      /** due: queued for the next payout. waiting_registration: credit stays on the hub until the account registers with the token. */
      status: r.status,
      credit: r.credit,
      paidTotal: r.paid_total,
      attempts: r.attempts,
      nextAttemptAt: r.status === "clear" ? null : new Date(r.next_attempt_unix * 1000).toISOString(),
      lastError: r.last_error,
      checkedAt: r.checked_at,
    };
  }

  /** `GET /v1/payouts`. */
  list(limit: number) {
    return {
      accounts: this.#db.all<PayoutAccountRow>("SELECT * FROM payout_accounts ORDER BY CASE status WHEN 'clear' THEN 1 ELSE 0 END, account").map((r) => this.accountJson(r)),
      payouts: this.#db.all<PayoutRow>("SELECT * FROM payouts ORDER BY seq DESC LIMIT ?", limit).map((p) => this.payoutJson(p)),
    };
  }
}
