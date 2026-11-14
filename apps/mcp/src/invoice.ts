/**
 * Paying a live invoice from another chain (the any-chain checkout, NEAR Intents): the agent sends the deposit from its
 * own wallet on the origin chain, and the business receives exactly the invoice amount of USDC.
 *
 * These tools only read and ask the node's public checkout routes (docs/DEVELOPERS.md, "Any-chain checkout"). Nothing
 * here holds a key, signs or sends: the agent's own wallet sends the deposit, and it must send exactly the amount, the
 * token and the network the deposit screen states, to the address it states, before its deadline.
 */
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { depositPaymentUri, isId, type IntentsOption, type IntentsQuote } from "@payminto/protocol";
import { cleanText, GatewayClient, NodeApiError } from "@payminto/sdk";

/** The id an agent names an origin by: the 1Click chain code and the token symbol, `base:USDC`. */
export const originKey = (o: { chain: string; symbol: string }) => `${o.chain}:${o.symbol}`;

/** A refusal of these tools: a code a program can act on, and a plain message. */
export class InvoiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InvoiceError";
    this.code = code;
  }
}

const PAID = new Set(["paid", "overpaid"]);

/** A waiting deposit's state in plain words. */
const WAITING_WORDS: Record<string, string> = {
  awaiting_deposit: "no deposit has arrived yet",
  deposit_detected: "the deposit arrived",
  incomplete_deposit: "less than the amount arrived: send the rest before the deadline, or it is returned",
  processing: "the deposit is being converted to USDC",
  delivered: "the USDC was sent to the business and is being checked on NEAR",
};
const sentence = (t: string) => t.replace(/[.\s]+$/, "");

export type InvoiceState = "paid" | "waiting" | "returned" | "failed" | "expired";

/**
 * The buyer side of the any-chain checkout against one Payminto server. Invoices are named by payment id, or by a
 * checkout or payment link URL of that same server; any other URL is refused.
 */
export class InvoicePayer {
  readonly nodeUrl: string;
  readonly client: GatewayClient;
  readonly #fetch: typeof fetch;
  #hosts: Promise<Set<string>> | null = null;

  constructor(o: { nodeUrl: string; fetch?: typeof fetch }) {
    this.nodeUrl = o.nodeUrl.replace(/\/+$/, "");
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    // No key: the public checkout routes need none, and a client without one can call nothing else.
    this.client = new GatewayClient({ nodeUrl: this.nodeUrl, fetch: this.#fetch });
  }

  /** The hosts of this server: the node, its public URL and its checkout pages (from its public `/v1/info`). */
  #ownHosts(): Promise<Set<string>> {
    this.#hosts ??= this.client
      .request<{ publicUrl?: unknown; gateway?: { checkoutBaseUrl?: unknown } }>("GET", "/v1/info", { auth: false })
      .then((info) => {
        const hosts = new Set([new URL(this.nodeUrl).host.toLowerCase()]);
        for (const u of [info.publicUrl, info.gateway?.checkoutBaseUrl]) {
          if (typeof u !== "string") continue;
          try {
            hosts.add(new URL(u).host.toLowerCase());
          } catch {
            // Not a URL: nothing to add.
          }
        }
        return hosts;
      })
      .catch((err: unknown) => {
        this.#hosts = null;
        throw err;
      });
    return this.#hosts;
  }

  /**
   * The payment an invoice reference names. A payment link (fixed amount) gets a new payment of its own, which is an
   * invoice like any other: nothing is paid by creating it.
   */
  async resolve(invoice: string): Promise<{ paymentId: string; fromLink: string | null }> {
    const ref = invoice.trim();
    if (isId("payment", ref)) return { paymentId: ref, fromLink: null };
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      throw new InvoiceError("INVOICE_NOT_RECOGNIZED", "pass a payment id (pay_...) or a checkout or payment link URL of this server");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvoiceError("INVOICE_NOT_RECOGNIZED", "pass a payment id (pay_...) or an http(s) checkout or payment link URL of this server");
    if (!(await this.#ownHosts()).has(url.host.toLowerCase())) {
      throw new InvoiceError("INVOICE_NOT_THIS_SERVER", `${url.host} is not this Payminto server; these tools pay only invoices of ${new URL(this.nodeUrl).host} and its checkout pages`);
    }
    const path = url.pathname.replace(/\/+$/, "");
    const pay = /^\/(?:pay|receipt|v1\/checkout)\/([^/]+)(?:\/.*)?$/.exec(path)?.[1];
    if (pay !== undefined) {
      if (!isId("payment", pay)) throw new InvoiceError("INVOICE_NOT_RECOGNIZED", "the URL names no payment id");
      return { paymentId: pay, fromLink: null };
    }
    const slug = /^\/(?:l|v1\/pay\/l|v1\/links\/public)\/([^/]+)$/.exec(path)?.[1];
    if (slug === undefined) throw new InvoiceError("INVOICE_NOT_RECOGNIZED", "the URL is not a checkout page (/pay/<payment id>) or a payment link (/l/<slug>) of this server");
    return { paymentId: await this.#paymentFromLink(decodeURIComponent(slug)), fromLink: slug };
  }

  async #paymentFromLink(slug: string): Promise<string> {
    const s = encodeURIComponent(slug);
    const link = await this.client.request<{ active?: boolean; amount?: string | null; collect_email?: boolean; collect_name?: boolean; intents?: { offered?: boolean; reason?: string | null } | null }>(
      "GET",
      `/v1/links/public/${s}`,
      { auth: false },
    );
    if (link.active === false) throw new InvoiceError("LINK_INACTIVE", "this payment link does not take payments now");
    if (!link.intents) throw new InvoiceError("INTENTS_CHECKOUT_OFF", "this server does not offer paying from another chain");
    if (!link.intents.offered) throw new InvoiceError("INTENTS_UNAVAILABLE", cleanText(link.intents.reason, 300) || "this link cannot be paid from another chain");
    if (link.amount === null || link.amount === undefined) throw new InvoiceError("LINK_OPEN_AMOUNT", "this link has no fixed amount; ask the user for the invoice (a payment id or checkout URL) to pay");
    if (link.collect_email || link.collect_name) throw new InvoiceError("LINK_NEEDS_DETAILS", "this link asks the buyer for an email or a name; ask the user to open it, or for the invoice to pay");
    const p = await this.client.request<{ id: string }>("POST", `/v1/links/public/${s}/payments`, { auth: false, body: {} });
    if (!isId("payment", p.id)) throw new InvoiceError("BAD_RESPONSE", "the server answered without a payment id");
    return p.id;
  }

  /** What the invoice can be paid with now: each offered token, with an indicative amount or the reason it is greyed. */
  async options(invoice: string) {
    const { paymentId, fromLink } = await this.resolve(invoice);
    const view = await this.client.checkout.retrieve(paymentId);
    if (!view.intents) throw new InvoiceError("INTENTS_CHECKOUT_OFF", "this server does not offer paying from another chain");
    const o = await this.client.checkout.anyChainOptions(paymentId);
    return {
      paymentId,
      createdFromLink: fromLink !== null,
      paymentStatus: view.status,
      merchant: cleanText(view.merchant?.name, 80) || null,
      mode: o.mode,
      label: o.label,
      available: view.intents.available,
      reason: view.intents.available ? null : cleanText(view.intents.reason, 300) || "this invoice cannot be paid from another chain now",
      merchantReceives: o.amount_out,
      recipient: o.recipient,
      settlementNetwork: o.settlement_network,
      pricesValidUntil: o.valid_until,
      expiresAt: view.expires_at,
      options: o.options.map((r: IntentsOption) => ({
        origin: originKey(r.origin),
        token: r.origin.symbol,
        network: r.origin.chain_name,
        available: r.available,
        reason: r.available ? null : cleanText(r.reason, 300) || "not offered now",
        estimate: r.amount_in,
        estimateUsd: r.amount_in_usd,
        timeEstimateSec: r.time_estimate_sec,
      })),
    };
  }

  /** The offered row an agent named, as `chain:SYMBOL` (chain code or name, any case) or as the 1Click asset id. */
  static pick(rows: readonly IntentsOption[], origin: string): IntentsOption | null {
    const want = origin.trim();
    const exact = rows.find((r) => r.origin.asset === want);
    if (exact) return exact;
    const at = want.lastIndexOf(":");
    if (at <= 0) return null;
    const chain = want.slice(0, at).toLowerCase();
    const symbol = want.slice(at + 1).toUpperCase();
    return rows.find((r) => r.origin.symbol.toUpperCase() === symbol && (r.origin.chain.toLowerCase() === chain || r.origin.chain_name.toLowerCase() === chain)) ?? null;
  }

  /** A deposit address for one origin: what the agent's own wallet sends, where, and by when. */
  async deposit(paymentId: string, origin: string, refundTo?: string) {
    if (!isId("payment", paymentId)) throw new InvoiceError("INVOICE_NOT_RECOGNIZED", "pass the payment id (pay_...) from invoice_pay_options");
    const o = await this.client.checkout.anyChainOptions(paymentId);
    const row = InvoicePayer.pick(o.options, origin);
    if (!row) throw new InvoiceError("ORIGIN_NOT_OFFERED", `${origin} is not offered for this invoice; offered: ${o.options.map((r) => originKey(r.origin)).join(", ") || "none"}`);
    if (!row.available) throw new InvoiceError("ORIGIN_UNAVAILABLE", `${originKey(row.origin)} cannot pay this invoice now: ${cleanText(row.reason, 300) || "not offered now"}`);
    const q = await this.client.checkout.createAnyChainQuote(paymentId, { originAsset: row.origin.asset, ...(refundTo?.trim() ? { refundTo: refundTo.trim() } : {}), idempotencyKey: randomUUID() });
    return depositView(q);
  }

  /** Where the invoice stands: paid, waiting, returned, failed or expired, with the delivery transaction once paid. */
  async status(paymentId: string, quoteId?: string) {
    if (!isId("payment", paymentId)) throw new InvoiceError("INVOICE_NOT_RECOGNIZED", "pass the payment id (pay_...) from invoice_pay_options");
    const view = await this.client.checkout.retrieve(paymentId);
    const q = quoteId ? await this.client.checkout.anyChainQuote(paymentId, quoteId) : (view.intents?.active_quote ?? null);
    const state: InvoiceState =
      PAID.has(view.status) || q?.status === "confirmed"
        ? "paid"
        : q?.status === "refunded"
          ? "returned"
          : q?.status === "failed"
            ? "failed"
            : q?.status === "expired" || (!q && (view.status === "expired" || view.status === "canceled"))
              ? "expired"
              : "waiting";
    return {
      paymentId,
      state,
      paymentStatus: view.status,
      amountDue: view.amount_due,
      amountPaid: view.amount_paid,
      mode: q?.mode ?? view.intents?.mode ?? null,
      label: q?.label ?? view.intents?.label ?? null,
      quote: q
        ? {
            quoteId: q.id,
            status: q.status,
            origin: originKey(q.origin),
            network: q.origin.chain_name,
            depositAddress: q.deposit_address,
            sendExactly: q.send_exactly,
            deadline: q.deadline,
            deadlinePassed: q.deadline_passed,
            steps: q.steps.map((s) => `${s.label}: ${s.state}`),
            deposited: q.deposited,
            delivered: q.delivered,
            refunded: q.refunded,
            refundReason: q.refund_reason ? cleanText(q.refund_reason, 300) : null,
            originTxs: q.origin_txs,
            deliveryTx: q.delivery_tx,
            verification: q.verification,
          }
        : null,
    };
  }
}

/** The deposit screen in the agent's terms, with the payment URI and the warning in plain words. */
function depositView(q: IntentsQuote) {
  const o = q.origin;
  const paymentUri = depositPaymentUri({ chain: o.chain, chainId: o.chain_id ?? null, contractAddress: o.contract_address ?? null, decimals: o.decimals, symbol: o.symbol }, q.deposit_address, q.send_exactly.amount);
  const amount = `${q.send_exactly.formatted} ${q.send_exactly.symbol}`;
  const money =
    q.mode === "live"
      ? "This is live: it moves real money."
      : "This is simulated: no real money moves, and this address is not a real address on that network. Send no real funds to it.";
  const warning =
    `Send exactly ${amount} (${q.send_exactly.amount} base units) on the ${o.chain_name} network to ${q.deposit_address} before ${q.deadline}. ` +
    `Send only ${o.symbol} on ${o.chain_name}: another token, another network, another amount or a deposit after the deadline may be lost. ` +
    `Never change the amount or the address. ${money}`;
  return {
    paymentId: q.payment_id,
    quoteId: q.id,
    status: q.status,
    mode: q.mode,
    label: q.label,
    sendExactly: q.send_exactly,
    token: { symbol: o.symbol, decimals: o.decimals, contractAddress: o.contract_address ?? null, asset: o.asset },
    network: { chain: o.chain, name: o.chain_name, chainId: o.chain_id ?? null },
    depositAddress: q.deposit_address,
    // Send by this time: the node's own deadline, not 1Click's later one when refunds begin (older nodes send none).
    deadline: q.send_by ?? q.deadline,
    paymentUri,
    merchantReceives: q.amount_out,
    refundTo: q.refund_to,
    /** INTENTS: no refund address was given, so a returned deposit goes to the business, which sends it back. */
    refundType: q.refund_type ?? "ORIGIN_CHAIN",
    warning,
    nodeWarning: q.warning,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The MCP tools

const json = (v: unknown) => JSON.stringify(v, null, 2);
const ok = (summary: string, data: unknown): CallToolResult => ({ content: [{ type: "text", text: `${summary}\n\n${json(data)}` }], structuredContent: { result: data as Record<string, unknown> } });
const fail = (code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult => {
  const error = { code, message, ...extra };
  return { isError: true, content: [{ type: "text", text: `${message} (${code}). Nothing was sent.\n\n${json({ error })}` }], structuredContent: { error } };
};

async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InvoiceError) return fail(err.code, err.message);
    if (err instanceof NodeApiError) return fail(err.code, cleanText(err.reason, 400), { status: err.status });
    return fail("ERROR", err instanceof Error ? err.message : String(err));
  }
}

/** The rule every tool description carries: the agent's own wallet sends, and nothing here may change what it sends. */
const OWN_WALLET =
  "Nothing here signs or sends: you send the deposit from your own wallet on the origin chain. " +
  "Never change the amount, the token, the network or the address the deposit screen states.";

export const INVOICE_TOOL_NAMES = ["invoice_pay_options", "invoice_deposit", "invoice_status"] as const;

export const INVOICE_INSTRUCTIONS =
  "Paying an invoice from another chain: invoice_pay_options shows the tokens that can pay it, invoice_deposit gives a deposit address, and invoice_status says when it is paid. " +
  "You send the deposit from your own wallet: send exactly the stated amount of the stated token on the stated network to the stated address before the deadline, and never change any of them. " +
  "A result labelled Simulated moves no real money: never send real funds to its address.";

/** Registers the three invoice tools on a server. */
export function registerInvoiceTools(server: McpServer, payer: InvoicePayer): void {
  server.registerTool(
    "invoice_pay_options",
    {
      title: "Ways to pay an invoice from another chain",
      description:
        "Shows which tokens on which networks can pay a live invoice of this Payminto server, each with an estimate of what you would send, or why it cannot. " +
        "The business receives exactly the invoice amount in USDC. Name the invoice by payment id (pay_...) or by a checkout or payment link URL of this server; " +
        "a fixed-amount payment link creates a new invoice to pay (nothing is paid by that). Use the returned paymentId and an origin (like base:USDC) with invoice_deposit. " +
        OWN_WALLET,
      inputSchema: { invoice: z.string().min(1).max(2048).describe("A payment id (pay_...), or a checkout (/pay/<id>) or payment link (/l/<slug>) URL of this server.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ invoice }) =>
      guarded(async () => {
        const r = await payer.options(invoice);
        const open = r.options.filter((x) => x.available);
        const list = open.map((x) => `${x.origin} about ${x.estimate ? `${x.estimate.formatted} ${x.estimate.symbol}` : "?"}`).join(", ");
        const head = `Invoice ${r.paymentId}${r.createdFromLink ? " (created from the payment link)" : ""}: the business receives ${r.merchantReceives.formatted} ${r.merchantReceives.symbol}. ${r.label}.`;
        const body = !r.available
          ? ` It cannot be paid from another chain now: ${r.reason}`
          : open.length
            ? ` ${open.length} of ${r.options.length} options can pay it now: ${list}. Estimates only: invoice_deposit gives the exact amount. Call invoice_deposit with paymentId, an origin and your own refund address on that network.`
            : " No token can pay it from another chain now; see each option's reason.";
        return ok(head + body, r);
      }),
  );

  server.registerTool(
    "invoice_deposit",
    {
      title: "Get a deposit address for an invoice",
      description:
        "Gets the deposit address to pay an invoice from another chain with one token: returns send exactly (the amount), the token, the network, the deposit address, the deadline, " +
        "a payment URI a wallet can open (EIP-681 or Solana Pay, null when there is none), and a warning. " +
        "Send exactly that amount of that token on that network to that address before the deadline; anything else may be lost. " +
        "refund_to is optional: your own address on the origin network, where a short or late deposit is returned; without it, a returned deposit goes to the business's NEAR Intents balance and the business sends it back. " +
        OWN_WALLET,
      inputSchema: {
        payment_id: z.string().min(1).max(64).describe("The invoice's payment id (pay_...) from invoice_pay_options."),
        origin: z.string().min(3).max(200).describe("The token to pay with, as network:SYMBOL from invoice_pay_options, for example base:USDC."),
        refund_to: z.string().min(1).max(128).optional().describe("Optional: your own address on the origin network, for a returned deposit. Give it so a short or late deposit comes straight back to you."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ payment_id, origin, refund_to }) =>
      guarded(async () => {
        const d = await payer.deposit(payment_id, origin, refund_to);
        return ok(`${d.label}. ${d.warning}`, d);
      }),
  );

  server.registerTool(
    "invoice_status",
    {
      title: "Invoice status",
      description:
        "Says whether an invoice paid from another chain is paid, waiting, returned (the deposit went back to your refund address), failed or expired, " +
        "with the deposit, and once paid the NEAR transaction that delivered the USDC to the business. Spends nothing. " +
        OWN_WALLET,
      inputSchema: {
        payment_id: z.string().min(1).max(64).describe("The invoice's payment id (pay_...)."),
        quote_id: z.string().min(1).max(64).optional().describe("A deposit address id (iq_...) from invoice_deposit; defaults to the invoice's newest one."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ payment_id, quote_id }) =>
      guarded(async () => {
        const s = await payer.status(payment_id, quote_id);
        const q = s.quote;
        const tx = q?.deliveryTx ? ` Delivered on NEAR in transaction ${q.deliveryTx.hash}${q.deliveryTx.explorer_url ? ` (${q.deliveryTx.explorer_url})` : ""}.` : "";
        const label = s.label ? ` ${s.label}.` : "";
        const text =
          s.state === "paid"
            ? `Invoice ${s.paymentId} is paid.${tx}${label}`
            : s.state === "returned"
              ? `Invoice ${s.paymentId} is not paid: the deposit was returned to the refund address${q?.refunded ? ` (${q.refunded.formatted} ${q.refunded.symbol})` : ""}${q?.refundReason ? `: ${sentence(q.refundReason)}` : ""}.${label}`
              : s.state === "failed"
                ? `Invoice ${s.paymentId} is not paid: the swap failed, and the deposit goes back to the refund address.${label}`
                : s.state === "expired"
                  ? `Invoice ${s.paymentId} is not paid, and ${q ? "its deposit address expired" : "it expired"}.${label}`
                  : !q
                    ? `Invoice ${s.paymentId} is waiting (${s.paymentStatus}); it has no deposit address yet: call invoice_deposit.${label}`
                    : q.deadlinePassed && q.status === "awaiting_deposit"
                      ? `Invoice ${s.paymentId} is waiting, and the deadline of deposit address ${q.quoteId} passed: send nothing to it, and call invoice_deposit for a new one.${label}`
                      : `Invoice ${s.paymentId} is waiting: ${WAITING_WORDS[q.status] ?? q.status.replaceAll("_", " ")} (deposit address ${q.quoteId}, deadline ${q.deadline}).${label}`;
        return ok(text, s);
      }),
  );
}
