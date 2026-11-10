/**
 * The any-chain checkout of the in-browser mock node, simulated end to end (docs/DEVELOPERS.md, "Any-chain checkout"):
 * dry-quote options, deposit addresses, a simulated deposit that runs through the same states the node reports, a
 * deposit that is too small and comes back, and the business's NEAR account with its three checks. Everything is
 * labeled "Simulated - no real money"; prices are a fixed table, never a live quote.
 */
import { CHECKOUT_ORIGINS, NEAR_MAINNET_USDC_ASSET, formatUnits, type CheckoutOrigin } from "@payminto/near-addons/intents";
import { INTENTS_LABELS, sha256Text } from "@payminto/protocol";
import { ApiError } from "../http";
import type {
  Credit,
  IntentsCheckout,
  IntentsFeeLines,
  IntentsOption,
  IntentsOptions,
  IntentsPayout,
  IntentsProof,
  IntentsQuote,
  IntentsQuoteStatus,
  IntentsStep,
  IntentsSummary,
  PaymentDetail,
  PaymentIntents,
  PublicLinkIntents,
} from "../schemas";

const USDC_CONTRACT = "usdc.near";
/** The account the demo's deliveries come from, as the local stack's simulated solver. */
const SOLVER = "solver.near";
/** Ten minutes or more must be left on a payment to pay it from another chain, as on the node. */
const MIN_WINDOW_MS = 600_000;
const QUOTE_TTL_MS = 1_800_000;
const MAX_ACTIVE = 5;

/** What the mock gateway lends this module: its payments, the method switch, and its state step and live stream. */
export type IntentsHost = {
  find(id: string): PaymentDetail;
  /** Whether the business has the `oneclick` method on. */
  enabled(merchantId: string): boolean;
  /** The payment's credits changed: recompute its status, and when `reopen`, put a payment with no credit back to open. */
  changed(p: PaymentDetail, opts?: { reopen?: boolean }): void;
  /** A timeline entry on the payment. */
  event(p: PaymentDetail, type: string, data?: Record<string, unknown>): void;
  merchant: { id: string; hub: string };
};

/** ETH in USD for the table; stablecoins are 1. */
const ETH_USD = 3_050;
const TIME_SEC: Record<string, number> = { base: 35, eth: 45, arb: 30, sol: 20, pol: 40 };
/** The smallest invoice each origin quotes for, in USDC base units; below it the row is greyed with the bridge's reason. */
const MIN_OUT: Record<string, bigint> = { "nep141:eth.omft.near": 30_000_000n };

type Row = {
  q: Omit<IntentsQuote, "refund_to" | "steps" | "deadline_passed" | "label" | "mode" | "object">;
  refundTo: string;
  credit: Credit | null;
  timers: ReturnType<typeof setTimeout>[];
};

const STEP_LABELS: Record<IntentsStep["key"], string> = { waiting: "Waiting for deposit", received: "Deposit received", converting: "Converting to USDC", delivered: "Delivered to merchant" };
const STEP_PROGRESS: Record<IntentsQuoteStatus, { done: number; failed: boolean }> = {
  awaiting_deposit: { done: 0, failed: false },
  incomplete_deposit: { done: 0, failed: false },
  deposit_detected: { done: 1, failed: false },
  processing: { done: 2, failed: false },
  delivered: { done: 3, failed: false },
  confirmed: { done: 4, failed: false },
  refunded: { done: 1, failed: true },
  failed: { done: 1, failed: true },
  expired: { done: 0, failed: true },
};

function steps(status: IntentsQuoteStatus): IntentsStep[] {
  const p = STEP_PROGRESS[status];
  return (["waiting", "received", "converting", "delivered"] as const).map((key, i) => ({ key, label: STEP_LABELS[key], state: i < p.done ? "done" : i === p.done ? (p.failed ? "failed" : "current") : "pending" }));
}

const mask = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const amount = (v: bigint, decimals: number, symbol: string) => ({ amount: v.toString(), formatted: formatUnits(v, decimals), symbol });

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Of(hex: string): string {
  let n = BigInt(`0x${hex}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return out;
}
let seq = 0;
const evmAddress = (label: string) => `0x${sha256Text(`mock-intents:${label}`).slice(0, 40)}`;
const evmTx = (label: string) => `0x${sha256Text(`mock-intents-tx:${label}:${seq++}`)}`;
const nearTx = (label: string) => base58Of(sha256Text(`mock-intents-near:${label}:${seq++}`));
const qid = () => `iq_${sha256Text(`mock-iq:${Date.now()}:${seq++}`).slice(0, 24).replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)}`;

/** The table price of an origin for an invoice of `out` USDC base units: what to send, the minimum, and its USD value. */
function price(o: CheckoutOrigin, out: bigint) {
  if (o.stable) {
    const amountIn = out + (out * 213n) / 100_000n;
    const minIn = out + (out * 113n) / 100_000n;
    return { amountIn, minIn, usd: Number(amountIn) / 1e6 };
  }
  const usd = (Number(out) / 1e6) * 1.0045;
  const amountIn = BigInt(Math.round((usd / ETH_USD) * 1.01 * 1e9)) * 1_000_000_000n;
  const minIn = (amountIn * 990n) / 1000n;
  return { amountIn, minIn, usd: (Number(amountIn) / 1e18) * ETH_USD };
}

function fees(o: CheckoutOrigin, out: bigint): IntentsFeeLines {
  const { amountIn, minIn, usd } = price(o, out);
  const swap = o.stable ? { amount: (minIn - out).toString(), formatted: formatUnits(minIn - out, o.decimals), unit: o.symbol } : (() => {
    const micro = BigInt(Math.max(0, Math.round((usd - Number(out) / 1e6) * 1e6)));
    return { amount: micro.toString(), formatted: formatUnits(micro, 6), unit: "USD" };
  })();
  return {
    send_exactly: amount(amountIn, o.decimals, o.symbol),
    merchant_receives: amount(out, 6, "USDC"),
    swap_cost: swap,
    price_buffer: amount(amountIn - minIn, o.decimals, o.symbol),
    refund_fee: o.stable ? amount(o.blockchain === "eth" ? 300_000n : 2_400n, o.decimals, o.symbol) : amount(800_000_000_000n, o.decimals, o.symbol),
    delivery_fee: amount(4_628n, 6, "USDC"),
    time_estimate_sec: TIME_SEC[o.blockchain] ?? 60,
  };
}

/**
 * The demo's one difference from the node: Acme Store's fee plan takes a platform fee, which a payment from another
 * chain cannot split off, so the node would not offer it for Acme's payments at all. The demo waives the fee on this
 * rail instead, so the flow can be clicked; on a node, a business on a plan with no platform fee gets the same result.
 */
function noFee(p: PaymentDetail) {
  Object.assign(p, { method: "oneclick", surcharge: "0", amount_due: p.amount, platform_fee: "0", method_fee: "0", fee_total: "0", net_amount: p.amount });
}

const originJson = (o: CheckoutOrigin) => ({ asset: o.assetId, chain: o.blockchain, chain_name: o.chainName, symbol: o.symbol, decimals: o.decimals });

export class MockIntents {
  readonly #rows = new Map<string, Row[]>();
  #payout: { account: string | null; exists: boolean | null; registered: boolean | null; provenAt: string | null };

  readonly #mode: "simulated" | "live";
  readonly #label: string;
  readonly #settlement: string;

  /**
   * `live` plays a server that runs the any-chain checkout live (`?demo=intents-live`), so its NEAR mainnet screens can
   * be walked: the labels and the settlement network say mainnet, and the demo wallet stands in for a mainnet wallet.
   * Nothing here reaches NEAR or 1Click either way.
   */
  constructor(
    private readonly host: IntentsHost,
    seed: { account: string | null; live?: boolean },
  ) {
    this.#mode = seed.live ? "live" : "simulated";
    this.#label = INTENTS_LABELS[this.#mode];
    this.#settlement = seed.live ? "near:mainnet" : "near:mainnet (simulated)";
    this.#payout = seed.account ? { account: seed.account, exists: true, registered: true, provenAt: new Date(Date.now() - 6 * 86_400_000).toISOString() } : { account: null, exists: null, registered: null, provenAt: null };
  }

  /** All three checks passed: the method can be on. */
  verified(): boolean {
    const p = this.#payout;
    return p.account !== null && p.exists === true && p.registered === true && p.provenAt !== null;
  }

  // ------------------------------------------------------------------ the hosted checkout

  /** Why this payment cannot be paid from another chain now, or null when it can. */
  #unavailable(p: PaymentDetail): string | null {
    if (!this.host.enabled(p.merchant_id ?? this.host.merchant.id) || !this.verified()) return "This business does not take payments from other chains.";
    if (p.status !== "open" || p.amount_paid !== "0") return "This payment no longer takes a new deposit address.";
    if (BigInt(p.surcharge) > 0n) return "This payment carries a fee, so it can only be paid from a NEAR wallet.";
    if (new Date(p.expires_at).getTime() - Date.now() < MIN_WINDOW_MS) return "This checkout expires too soon to pay from another chain.";
    return null;
  }

  checkout(p: PaymentDetail): IntentsCheckout {
    const reason = this.#unavailable(p);
    const rows = (this.#rows.get(p.id) ?? []).filter((r) => r.q.status !== "expired");
    const newest = rows.at(-1);
    return { mode: this.#mode, label: this.#label, available: reason === null, reason, settlement_network: this.#settlement, active_quote: newest ? this.#json(newest) : null };
  }

  /** `methods` gains `oneclick` while the payment can be paid from another chain. */
  offered(p: PaymentDetail): boolean {
    return this.#unavailable(p) === null;
  }

  options(paymentId: string): IntentsOptions {
    const p = this.host.find(paymentId);
    const reason = this.#unavailable(p);
    if (reason) throw new ApiError(409, "INTENTS_UNAVAILABLE", reason);
    const out = BigInt(p.amount_due);
    const options: IntentsOption[] = CHECKOUT_ORIGINS.map((o) => {
      const min = MIN_OUT[o.assetId];
      if (min && out < min) {
        return { origin: originJson(o), available: false, reason: `The bridge needs at least ${formatUnits(min, 6)} USDC for this route.`, slippage_bps: 100, amount_in: null, amount_in_usd: null, time_estimate_sec: null, fees: null };
      }
      const f = fees(o, out);
      return { origin: originJson(o), available: true, reason: null, slippage_bps: o.stable ? 10 : 100, amount_in: f.send_exactly, amount_in_usd: price(o, out).usd.toFixed(6), time_estimate_sec: f.time_estimate_sec, fees: f };
    });
    const at = Date.now();
    return {
      object: "intents_options",
      payment_id: p.id,
      mode: this.#mode,
      label: this.#label,
      amount_out: amount(out, 6, "USDC"),
      recipient: this.#payout.account ?? "",
      settlement_network: this.#settlement,
      quoted_at: new Date(at).toISOString(),
      valid_until: new Date(at + 30_000).toISOString(),
      options,
    };
  }

  createQuote(paymentId: string, body: { origin_asset: string; refund_to: string }): { quote: IntentsQuote; reused: boolean } {
    const p = this.host.find(paymentId);
    const o = CHECKOUT_ORIGINS.find((x) => x.assetId === body.origin_asset);
    if (!o) throw new ApiError(400, "ORIGIN_NOT_OFFERED", "This token is not offered for this payment.");
    const refund = body.refund_to.trim();
    const okAddress = o.addressFormat === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(refund) && !/^0x0{40}$/.test(refund) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(refund);
    if (!okAddress) throw new ApiError(400, "INVALID_REFUND_ADDRESS", `The refund address is not an address on ${o.chainName}.`);
    const reason = this.#unavailable(p);
    if (reason) throw new ApiError(409, "INTENTS_UNAVAILABLE", reason);
    const rows = this.#rows.get(p.id) ?? [];
    const reuse = rows.find((r) => r.q.origin.asset === o.assetId && r.refundTo === refund && r.q.status === "awaiting_deposit" && new Date(r.q.deadline).getTime() - Date.now() >= MIN_WINDOW_MS);
    if (reuse) return { quote: this.#json(reuse), reused: true };
    if (rows.filter((r) => r.q.status === "awaiting_deposit" && new Date(r.q.deadline).getTime() > Date.now()).length >= MAX_ACTIVE) {
      throw new ApiError(409, "INTENTS_QUOTE_LIMIT", "Five deposit addresses of this payment are waiting already. Use one of them, or wait for them to expire.");
    }
    const out = BigInt(p.amount_due);
    if (MIN_OUT[o.assetId] && out < MIN_OUT[o.assetId]!) throw new ApiError(502, "INTENTS_QUOTE_FAILED", `The bridge needs at least ${formatUnits(MIN_OUT[o.assetId]!, 6)} USDC for this route.`);
    const row = this.#build(p, o, refund, Date.now());
    this.#rows.set(p.id, [...rows, row]);
    // The node re-quotes an untouched payment for the method in use; the fee is zero on this rail.
    if (p.status === "open" && p.credits.length === 0) noFee(p);
    this.host.event(p, "intents.quote_created", { origin: `${o.symbol} on ${o.chainName}`, amount: row.q.send_exactly.amount });
    this.host.changed(p);
    return { quote: this.#json(row), reused: false };
  }

  /**
   * History for the console: a payment that was paid from another chain at `atMs`, delivered and checked, with its
   * confirmed credit. Its payment must be open with nothing received; the caller marks it paid.
   */
  seedPaid(p: PaymentDetail, assetId: string, refundTo: string, atMs: number): void {
    const o = CHECKOUT_ORIGINS.find((x) => x.assetId === assetId)!;
    noFee(p);
    const row = this.#build(p, o, refundTo, atMs - 4 * 60_000);
    const delivery = nearTx(`${row.q.id}:delivery`);
    Object.assign(row.q, {
      status: "confirmed",
      provider_status: "SUCCESS",
      deposited: row.q.send_exactly,
      delivered: row.q.amount_out,
      origin_txs: [{ hash: evmTx(row.q.id), explorer_url: null }],
      destination_txs: [{ hash: delivery, explorer_url: null }],
      near_txs: [delivery],
      delivery_tx: { hash: delivery, explorer_url: null },
      verification: "rpc_checked",
      updated_at: new Date(atMs).toISOString(),
    } satisfies Partial<IntentsQuote>);
    p.credits.push({ payment_id: p.id, method: "oneclick", payer: `${o.blockchain}:${refundTo}`, amount: row.q.amount_out.amount, tx_hash: delivery, batch_id: null, call_id: null, recorded_at_ms: null, status: "confirmed", late: false, created_at: new Date(atMs - 60_000).toISOString(), confirmed_at: new Date(atMs).toISOString() });
    this.#rows.set(p.id, [...(this.#rows.get(p.id) ?? []), row]);
  }

  #build(p: PaymentDetail, o: CheckoutOrigin, refund: string, now: number): Row {
    const out = BigInt(p.amount_due);
    const f = fees(o, out);
    const { amountIn, minIn, usd } = price(o, out);
    const deadline = Math.min(new Date(p.expires_at).getTime(), now + QUOTE_TTL_MS);
    const id = qid();
    const addr = o.addressFormat === "evm" ? evmAddress(id) : base58Of(sha256Text(`mock-intents-sol:${id}`));
    const row: Row = {
      refundTo: refund,
      credit: null,
      timers: [],
      q: {
        id,
        payment_id: p.id,
        status: "awaiting_deposit",
        provider_status: "PENDING_DEPOSIT",
        origin: originJson(o),
        deposit_address: addr,
        deposit_memo: null,
        send_exactly: amount(amountIn, o.decimals, o.symbol),
        min_amount_in: amount(minIn, o.decimals, o.symbol),
        amount_out: amount(out, 6, "USDC"),
        amount_in_usd: usd.toFixed(6),
        fees: f,
        slippage_bps: o.stable ? 10 : 100,
        time_estimate_sec: f.time_estimate_sec,
        recipient: this.#payout.account ?? "",
        settlement_network: this.#settlement,
        deadline: new Date(deadline).toISOString(),
        inactive_at: new Date(deadline).toISOString(),
        deposited: null,
        delivered: null,
        refunded: null,
        refund_reason: null,
        origin_txs: [],
        destination_txs: [],
        near_txs: [],
        delivery_tx: null,
        verification: null,
        warning: `Send only ${o.symbol} on the ${o.chainName} network, to this address. Other tokens, other networks, or a deposit after ${hhmm(deadline)} UTC may be lost.`,
        correlation_id: `mock-${sha256Text(id).slice(0, 8)}-${sha256Text(id).slice(8, 12)}`,
        signature_valid: true,
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
    };
    return row;
  }

  quote(paymentId: string, quoteId: string): IntentsQuote {
    return this.#json(this.#row(paymentId, quoteId));
  }

  /** "I've sent it": in simulated mode a hash alone moves nothing; the quote answers as it is. */
  submitDeposit(paymentId: string, quoteId: string, txHash: string): IntentsQuote {
    if (!/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,90})$/.test(txHash)) throw new ApiError(400, "VALIDATION_ERROR", "tx_hash: must be a transaction hash on the origin chain");
    const r = this.#row(paymentId, quoteId);
    if (!r.q.origin_txs.some((t) => t.hash === txHash)) r.q.origin_txs = [...r.q.origin_txs, { hash: txHash, explorer_url: null }];
    this.#touch(r);
    return this.#json(r);
  }

  /** A deposit on the simulated 1Click: the full amount runs to delivered and confirmed; too little comes back. */
  simulate(paymentId: string, quoteId: string, amountIn?: string): IntentsQuote {
    const p = this.host.find(paymentId);
    const r = this.#row(paymentId, quoteId);
    if (!["awaiting_deposit", "incomplete_deposit"].includes(r.q.status)) throw new ApiError(409, "INTENTS_QUOTE_DONE", "This deposit address already received its deposit.");
    const sent = BigInt(amountIn ?? r.q.send_exactly.amount);
    const total = (r.q.deposited ? BigInt(r.q.deposited.amount) : 0n) + sent;
    const o = r.q.origin;
    r.q.deposited = amount(total, o.decimals, o.symbol);
    r.q.origin_txs = [...r.q.origin_txs, { hash: o.chain === "sol" ? nearTx(r.q.id) : evmTx(r.q.id), explorer_url: null }];
    const payer = `${o.chain}:${r.refundTo}`;
    if (!r.credit) {
      r.credit = { payment_id: p.id, method: "oneclick", payer, amount: r.q.amount_out.amount, tx_hash: null, batch_id: null, call_id: null, recorded_at_ms: null, status: "pending", late: false, created_at: new Date().toISOString(), confirmed_at: null };
      p.credits.push(r.credit);
    }
    const short = total < BigInt(r.q.min_amount_in.amount);
    this.#set(p, r, short ? "incomplete_deposit" : "deposit_detected", short ? "INCOMPLETE_DEPOSIT" : "KNOWN_DEPOSIT_TX");
    if (short) {
      // Nothing tops it up in the demo: 1Click returns it, less its refund fee.
      this.#later(r, 4_000, () => {
        const fee = r.q.fees.refund_fee ? BigInt(r.q.fees.refund_fee.amount) : 0n;
        r.q.refunded = amount(total > fee ? total - fee : 0n, o.decimals, o.symbol);
        r.q.refund_reason = "PARTIAL_DEPOSIT";
        p.credits = p.credits.filter((c) => c !== r.credit);
        r.credit = null;
        this.#set(p, r, "refunded", "REFUNDED", { reopen: true });
        this.host.event(p, "payment.deposit_returned", { amount: r.q.refunded.amount, reason: "PARTIAL_DEPOSIT" });
      });
    } else {
      this.#later(r, 1_800, () => this.#set(p, r, "processing", "PROCESSING"));
      this.#later(r, 3_600, () => {
        const hash = nearTx(`${r.q.id}:delivery`);
        r.q.destination_txs = [{ hash, explorer_url: null }];
        r.q.near_txs = [hash];
        r.q.delivery_tx = { hash, explorer_url: null };
        r.q.delivered = r.q.amount_out;
        this.#set(p, r, "delivered", "SUCCESS");
      });
      this.#later(r, 5_000, () => {
        r.q.verification = "rpc_checked";
        if (r.credit) {
          r.credit.status = "confirmed";
          r.credit.confirmed_at = new Date().toISOString();
          r.credit.tx_hash = r.q.delivery_tx?.hash ?? null;
        }
        this.#set(p, r, "confirmed", "SUCCESS");
      });
    }
    return this.#json(r);
  }

  /** `intents` on a list item: the confirmed quote of the payment, else its newest one; null when it has none. */
  summary(paymentId: string): IntentsSummary | null {
    const rows = this.#rows.get(paymentId) ?? [];
    const r = rows.find((x) => x.q.status === "confirmed") ?? rows.at(-1);
    if (!r) return null;
    const { asset, chain, chain_name, symbol } = r.q.origin;
    return { mode: this.#mode, label: this.#label, status: r.q.status, origin: { asset, chain, chain_name, symbol } };
  }

  /** `intents` on the public link: offered while the business takes payments from other chains. */
  linkOffer(merchantId: string): PublicLinkIntents {
    const offered = this.host.enabled(merchantId) && this.verified();
    return { mode: this.#mode, label: this.#label, offered, reason: offered ? null : "This business does not take payments from other chains." };
  }

  /** The proof of a payment paid from another chain: its delivery on NEAR, and what 1Click reported. */
  proof(paymentId: string): IntentsProof | null {
    const r = (this.#rows.get(paymentId) ?? []).find((x) => x.q.status === "confirmed");
    if (!r || !r.q.delivery_tx) return null;
    return {
      method: "oneclick",
      amount: r.q.amount_out.amount,
      payer: `${r.q.origin.chain}:${mask(r.refundTo)}`,
      quote_id: r.q.id,
      mode: this.#mode,
      label: this.#label,
      settlement_network: this.#settlement,
      token: USDC_CONTRACT,
      recipient: r.q.recipient,
      origin: r.q.origin,
      deposited: r.q.deposited,
      origin_txs: r.q.origin_txs,
      delivery_tx: r.q.delivery_tx,
      delivery_senders: [SOLVER, r.q.recipient],
      oneclick: { status: r.q.provider_status, correlation_id: r.q.correlation_id, deposit_address: r.q.deposit_address, read_at: r.q.updated_at },
      verification: r.q.verification,
      delivered_on_chain: r.q.amount_out.amount,
      verified: true,
    };
  }

  /** The demo chain's receipts of a delivery transaction: the USDC contract's NEP-141 transfer to the business. */
  deliveryReceipts(hash: string): Array<{ id: string; outcome: { executor_id: string; logs: string[]; status: { SuccessValue: string } } }> | null {
    for (const rows of this.#rows.values()) {
      const r = rows.find((x) => x.q.delivery_tx?.hash === hash);
      if (!r) continue;
      const event = { standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: SOLVER, new_owner_id: r.q.recipient, amount: r.q.amount_out.amount, memo: "NEAR Intents delivery (simulated)" }] };
      return [{ id: `${hash}:usdc`, outcome: { executor_id: USDC_CONTRACT, logs: [`EVENT_JSON:${JSON.stringify(event)}`], status: { SuccessValue: "" } } }];
    }
    return null;
  }

  /** `intents` on the business's payment detail: every quote, the refund address in full and the signed answer. */
  paymentIntents(paymentId: string): PaymentIntents | null {
    const rows = this.#rows.get(paymentId) ?? [];
    if (rows.length === 0) return null;
    return { mode: this.#mode, label: this.#label, quotes: rows.map((r) => this.#json(r, true)) };
  }

  // ------------------------------------------------------------------ the business's NEAR account

  payout(): IntentsPayout {
    const p = this.#payout;
    const registered = p.account ? p.registered : null;
    return {
      object: "intents_payout",
      mode: this.#mode,
      label: this.#label,
      settlement_network: this.#settlement,
      account: p.account,
      verified: this.verified(),
      checks: { exists: p.account ? p.exists : null, usdc_registered: registered, proven: p.provenAt !== null, proven_at: p.provenAt },
      usdc: { contract: USDC_CONTRACT, asset_id: NEAR_MAINNET_USDC_ASSET, decimals: 6 },
      storage_step:
        p.account && registered === false
          ? {
              why: `${p.account} is not registered with USDC yet, so a delivery to it would fail. Send this storage_deposit from ${p.account} (it costs 0.00125 NEAR, once).`,
              deposit_near: "0.00125",
              transaction: { receiverId: USDC_CONTRACT, actions: [{ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: p.account, registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" } }] },
            }
          : null,
      enabled: this.host.enabled(this.host.merchant.id),
      proof_scope: { settlement_network: this.#settlement, hub: this.host.merchant.hub },
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * Sets the account. The demo checks only the shape of the proof (a real signature is checked by the node); an account
   * whose name starts with "new" plays one that is not registered with USDC yet, so the storage step can be seen.
   */
  setPayout(body: { account: string; proof: { timestamp: number; public_key: string; signature: string } }): IntentsPayout {
    if (!/^[a-z0-9._-]{2,64}$/.test(body.account)) throw new ApiError(400, "VALIDATION_ERROR", "account: must be a NEAR account id");
    if (!body.proof.signature || !body.proof.public_key.startsWith("ed25519:")) throw new ApiError(400, "INVALID_PROOF", "The signature does not match the message.");
    this.#payout = { account: body.account, exists: true, registered: !body.account.startsWith("new"), provenAt: new Date().toISOString() };
    return this.payout();
  }

  /** The demo's stand-in for the storage deposit landing: the next read sees the account registered. */
  markRegistered(): void {
    if (this.#payout.account) this.#payout.registered = true;
  }

  /** `PUT /v1/merchants/{id}/methods` turning `oneclick` on, refused like the node until the account is verified. */
  assertCanEnable(): void {
    const p = this.#payout;
    if (!p.account || !p.provenAt) throw new ApiError(409, "INTENTS_PAYOUT_REQUIRED", "set a NEAR account for any-chain payments first (PUT /v1/merchant/intents-payout)");
    if (!p.registered) throw new ApiError(409, "INTENTS_PAYOUT_NOT_REGISTERED", `${p.account} is not registered with USDC yet; send the storage_deposit shown by GET /v1/merchant/intents-payout`);
  }

  // ------------------------------------------------------------------ internals

  #row(paymentId: string, quoteId: string): Row {
    const r = (this.#rows.get(paymentId) ?? []).find((x) => x.q.id === quoteId);
    if (!r) throw new ApiError(404, "NOT_FOUND", "no such quote for this payment");
    return r;
  }

  #touch(r: Row) {
    r.q.updated_at = new Date().toISOString();
  }

  #set(p: PaymentDetail, r: Row, status: IntentsQuoteStatus, provider: string, opts?: { reopen?: boolean }) {
    r.q.status = status;
    r.q.provider_status = provider;
    this.#touch(r);
    this.host.changed(p, opts);
  }

  #later(r: Row, ms: number, f: () => void) {
    r.timers.push(setTimeout(f, ms));
  }

  #json(r: Row, merchant = false): IntentsQuote {
    const deadlinePassed = Date.now() >= new Date(r.q.deadline).getTime();
    const out: IntentsQuote = { ...r.q, object: "intents_quote", mode: this.#mode, label: this.#label, refund_to: merchant ? r.refundTo : mask(r.refundTo), steps: steps(r.q.status), deadline_passed: deadlinePassed };
    if (merchant) out.quote_response = { correlationId: r.q.correlation_id, simulated: true, note: "The in-browser demo's quote; no 1Click server answered it." };
    return out;
  }
}
