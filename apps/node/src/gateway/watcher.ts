import type { AccountId, Id32 } from "@payminto/protocol";
import type { ChainClient } from "../chain.ts";
import type { Database } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import type { PaymentRow } from "./model.ts";
import type { PaymentService } from "./payments.ts";

/** Ids per `Chain.payments` read. */
export const PAYMENTS_PER_READ = 100;

/**
 * Wallet checkout watcher: polls the hub's record of every watched payment's checkout id with `Chain.payments(ids)`.
 * The RPC client reads at final finality, so a record the hub returns is final: there are no logs, cursors or reorgs
 * to follow. A recorded payment becomes a confirmed wallet credit, and its merchant is queued for payout.
 */
export class PaymentWatcher {
  readonly #db: Database;
  readonly #chain: ChainClient;
  readonly #payments: PaymentService;
  readonly #log: Logger;
  readonly #onRecorded: (p: PaymentRow, merchant: AccountId, payer: AccountId) => void;
  #busy: Promise<number> | null = null;

  constructor(o: {
    db: Database;
    chain: ChainClient;
    payments: PaymentService;
    log: Logger;
    /** Runs in the transaction that records the credit (payout queueing, screening records). */
    onRecorded?: (p: PaymentRow, merchant: AccountId, payer: AccountId) => void;
  }) {
    this.#db = o.db;
    this.#chain = o.chain;
    this.#payments = o.payments;
    this.#log = o.log;
    this.#onRecorded = o.onRecorded ?? (() => undefined);
  }

  /** One pass over every watched payment; overlapping calls share it. Resolves to the number of credits recorded. */
  tick(): Promise<number> {
    this.#busy ??= this.#run().finally(() => {
      this.#busy = null;
    });
    return this.#busy;
  }

  /** Checks one payment now (the checkout page calls this after the wallet reports its transaction). */
  async check(p: PaymentRow): Promise<boolean> {
    return (await this.#apply([p])) > 0;
  }

  async #run(): Promise<number> {
    const watched = this.#payments.watched();
    let recorded = 0;
    for (let i = 0; i < watched.length; i += PAYMENTS_PER_READ) recorded += await this.#apply(watched.slice(i, i + PAYMENTS_PER_READ));
    return recorded;
  }

  async #apply(rows: PaymentRow[]): Promise<number> {
    const records = await this.#chain.chain.payments(rows.map((p) => p.checkout_id as Id32));
    let recorded = 0;
    rows.forEach((p, i) => {
      const r = records[i];
      if (!r) return;
      if (r.id !== p.checkout_id) {
        this.#log.error("the hub returned a payment record for another id; ignoring it", { paymentId: p.id, expected: p.checkout_id, got: r.id });
        return;
      }
      // The hub credited exactly what it recorded to the merchant it recorded. Count that, whatever this payment says now:
      // a mismatch means terms signed before a re-quote were paid, and the state machine shows the difference.
      if (r.merchant !== p.payout || r.amount !== BigInt(p.amount_due)) {
        this.#log.warn("a wallet payment differs from the payment's current terms", { paymentId: p.id, merchant: r.merchant, amount: r.amount.toString(), due: p.amount_due });
      }
      const inserted = this.#db.tx(() => {
        const out = this.#payments.addCredit({
          paymentId: p.id,
          method: "wallet",
          payer: r.payer,
          amount: r.amount,
          txHash: p.wallet_tx_hash,
          checkoutId: r.id,
          recordedAtMs: r.at,
          status: "confirmed",
          mayBeLate: true,
        });
        if (out.inserted) this.#onRecorded(this.#payments.row(p.id)!, r.merchant, r.payer);
        return out.inserted;
      });
      if (inserted) {
        recorded++;
        this.#log.info("wallet payment recorded by the hub", { paymentId: p.id, payer: r.payer, amount: r.amount.toString() });
      }
    });
    return recorded;
  }
}
