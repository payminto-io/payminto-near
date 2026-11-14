import { checkoutUrl } from "@payminto/protocol";
import type { Email } from "../auth/mailer.ts";
import type { Database } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { nowIso } from "../store.ts";
import type { MerchantService } from "./merchants.ts";
import type { PaymentRow } from "./model.ts";
import { decimalOf } from "./reports.ts";

/** Where an any-chain payment came from, as the checkout shows it ("USDC" on "Base"). */
export type ReceiptOrigin = { symbol: string; chain_name: string };

export type ReceiptDeps = {
  db: Database;
  /** The node's mailer: stores the email in the current transaction (the outbox) and delivers it after commit. */
  mailer: { queue(e: Email): number };
  merchants: MerchantService;
  token: { symbol: string; decimals: number };
  checkoutBaseUrl: string;
  /** The origin of a payment's confirmed any-chain quote; absent when the any-chain checkout is off. */
  originOf?: (paymentId: string) => ReceiptOrigin | null;
  log: Logger;
};

/**
 * The receipt email a buyer gets once a payment is paid (docs/DEVELOPERS.md, "Receipt email"): the checkout promises it
 * when the buyer leaves an email. It is queued through the node's mailer in the transaction that marks the payment
 * paid (or that saves the email on a paid payment), and `payments.receipt_sent_at` is set in the same transaction, so
 * a restart, a recompute or a second save never sends it twice. Without SMTP it is written to the outbox and the log.
 */
export class ReceiptService {
  readonly #d: ReceiptDeps;

  constructor(d: ReceiptDeps) {
    this.#d = d;
  }

  /** Queues the receipt of a paid payment with a customer email, once. Must run inside the caller's transaction. */
  send(p: PaymentRow): boolean {
    if (!p.customer_email || !p.paid_at || p.draft) return false;
    const claimed = this.#d.db.run("UPDATE payments SET receipt_sent_at = ? WHERE id = ? AND receipt_sent_at IS NULL", nowIso(), p.id).changes === 1;
    if (!claimed) return false;
    const email = this.email(p);
    this.#d.mailer.queue(email);
    this.#d.log.info("receipt email queued", { paymentId: p.id });
    return true;
  }

  /** The email itself: plain text with the amount and token, how it was paid, when (UTC), the receipt link and support. */
  email(p: PaymentRow): Email {
    const m = this.#d.merchants.merchant(p.merchant_id);
    const link = checkoutUrl(this.#d.checkoutBaseUrl, p.id);
    const amount = `${trimmed(decimalOf(BigInt(p.amount_paid), this.#d.token.decimals))} ${this.#d.token.symbol}`;
    const lines = [
      `Thank you for your payment to ${m.name}.`,
      "",
      `Amount: ${amount}`,
      ...(p.description ? [`For: ${p.description}`] : []),
      ...(p.reference ? [`Reference: ${p.reference}`] : []),
      `Paid with: ${this.#how(p)}`,
      `Paid at: ${utc(p.paid_at!)}`,
      `Payment: ${p.id}`,
      "",
      `Receipt: ${link}`,
      ...(m.support_email ? ["", `Questions about this payment? Write to ${m.support_email}.`] : []),
    ];
    return { to: p.customer_email!, subject: `Receipt from ${m.name}`, text: lines.join("\n"), link, kind: "receipt" };
  }

  #how(p: PaymentRow): string {
    const method = p.method ?? p.quote_method;
    if (method === "oneclick") {
      const o = this.#d.originOf?.(p.id) ?? null;
      return o ? `From ${o.symbol} on ${o.chain_name} through NEAR Intents` : "From another chain through NEAR Intents";
    }
    if (method === "voucher") return "An agent Budget voucher";
    return "A NEAR wallet";
  }
}

/** "5.000000" -> "5.00", "1.250000" -> "1.25", "0.001000" -> "0.001": at least two decimals, no trailing zeros past them. */
function trimmed(v: string): string {
  const [whole, frac = ""] = v.split(".");
  const kept = frac.replace(/0+$/, "");
  return `${whole}.${kept.padEnd(2, "0")}`;
}

function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
