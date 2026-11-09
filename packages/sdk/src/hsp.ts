import { getAddress, isAddressEqual, type Address, type LocalAccount } from "viem";
import { z } from "zod";
import { decodeHeader, HEADER_REQUIRED, HSP_SCHEME, hspAgenticTypedData, X402_VERSION, type HspEip712Json, type HspStatus } from "@payminto/protocol";
import { errorSchema, zAddress, zUint } from "./node-api.ts";

// HSP payer (docs/GATEWAY.md section 17), for agents with a plain wallet that pay through HashKey's HSP. Like
// payExact this is not mandate-bound: a mandate agent pays with AgentClient (payminto-voucher), the only path checked
// against the owner's policy.

const hspRequirementSchema = z
  .object({
    scheme: z.literal(HSP_SCHEME),
    network: z.string().regex(/^eip155:\d+$/),
    asset: zAddress,
    payTo: zAddress,
    amount: zUint,
    extra: z.object({ paymentId: z.string().min(1), prepareUrl: z.string().min(1), submitUrl: z.string().min(1), statusUrl: z.string().min(1) }).loose(),
  })
  .loose();
export type HspRequirement = z.infer<typeof hspRequirementSchema>;

const requiredSchema = z.object({ x402Version: z.literal(X402_VERSION), accepts: z.array(z.unknown()) }).loose();

const preparedSchema = z
  .object({
    payment_id: z.string(),
    flow_id: z.string(),
    protocol: z.string(),
    eip712: z.object({ domain: z.record(z.string(), z.unknown()), types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))), primaryType: z.string(), message: z.record(z.string(), z.unknown()) }),
    token_total_raw: zUint,
    quote_expires_at: z.string(),
    recipient: zAddress,
    payer: zAddress,
  })
  .loose();

const hspStateSchema = z
  .object({
    status: z.string().nullable(),
    status_reason: z.string().nullable().optional(),
    tx_hash: z.string().nullable().optional(),
    attribution_verified: z.boolean().optional(),
  })
  .loose();
const statusSchema = z.object({ payment_id: z.string(), status: z.string(), flow_id: z.string().nullable().optional(), hsp: hspStateSchema }).loose();

export type HspPaymentState = {
  paymentId: string;
  /** The Payminto payment status (paid once the transfer reached the payment's forwarder). */
  status: string;
  flowId: string | null;
  hspStatus: HspStatus | null;
  statusReason: string | null;
  txHash: string | null;
  attributionVerified: boolean;
};

export type PayHspOptions = {
  /** The payer wallet; it signs HSP's EIP-712 data and never sends a transaction (the HSP gateway broadcasts). */
  account: LocalAccount;
  /** Refuse (without signing) any payment above this many base units. */
  maxAmount: bigint;
  /** Only pay on this chain (CAIP-2 `eip155:<chainId>`). */
  chainId?: number;
  /** Only pay in this token. */
  asset?: Address;
  /**
   * What to wait for: `paid` (default) until the payment is paid, `finalized` until HSP also reports
   * payment-finalized, `submitted` only until HSP accepted the submission.
   */
  waitFor?: "submitted" | "paid" | "finalized";
  timeoutMs?: number;
  pollMs?: number;
  /** New quotes to try when HSP says the quote expired (each one is signed again). */
  maxRequotes?: number;
  /** Request init for the first request (method, headers, a replayable body). */
  init?: RequestInit;
  fetch?: typeof fetch;
};

export type HspPayment = HspPaymentState & { requirement: HspRequirement };

/** A payment payHsp refused to make, or that HSP or the server refused or failed. */
export class HspPaymentError extends Error {
  readonly code: string;
  readonly response: Response | null;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, response: Response | null = null, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "HspPaymentError";
    this.code = code;
    this.response = response;
    this.details = details;
  }
}

const REQUOTE_CODES = new Set(["HSP_QUOTE_EXPIRED", "HSP_QUOTE_MISMATCH"]);

/**
 * Pays an x402 resource through HashKey's HSP: requests it, picks the `hsp` offer from PAYMENT-REQUIRED, prepares an
 * HSP quote for the account, checks it pays exactly the offered amount into the offered forwarder in the offered
 * token, signs HSP's EIP-712 data, submits the signature and waits (see `waitFor`). An expired quote is prepared and
 * signed again; an old signature is never resent. Throws HspPaymentError when there is no payable offer, the price is
 * above maxAmount, HSP reports payment-failed, or the wait times out.
 */
export async function payHsp(url: string | URL, o: PayHspOptions): Promise<HspPayment> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const first = await doFetch(url, o.init ?? {});
  if (first.status !== 402) throw new HspPaymentError("NOT_PAYMENT_REQUIRED", `the resource answered HTTP ${first.status} without asking for a payment`, first);
  let raw = decodeHeader<unknown>(first.headers.get(HEADER_REQUIRED));
  if (!raw) raw = await first.clone().json().catch(() => null);
  const required = requiredSchema.safeParse(raw);
  if (!required.success) throw new HspPaymentError("INVALID_REQUIREMENTS", "the 402 carries no x402 v2 PAYMENT-REQUIRED", first);
  const requirement = required.data.accepts.flatMap((a) => {
    const r = hspRequirementSchema.safeParse(a);
    if (!r.success) return [];
    if (o.chainId !== undefined && r.data.network !== `eip155:${o.chainId}`) return [];
    if (o.asset && !isAddressEqual(r.data.asset, o.asset)) return [];
    return [r.data];
  })[0];
  if (!requirement) throw new HspPaymentError("NO_HSP_OFFER", "the resource offers no HSP payment for this chain and token", first);
  const amount = BigInt(requirement.amount);
  if (amount <= 0n) throw new HspPaymentError("INVALID_REQUIREMENTS", "the HSP amount must be positive", first);
  if (amount > o.maxAmount) {
    throw new HspPaymentError("MAX_AMOUNT", `price ${amount} exceeds maxAmount ${o.maxAmount}; nothing was signed`, first, { amount: amount.toString(), maxAmount: o.maxAmount.toString() });
  }
  const base = new URL(url);
  const at = (u: string) => new URL(u, base);
  const chainId = Number(requirement.network.slice("eip155:".length));
  const payer = o.account.address;

  const post = async (u: string, body: unknown) => {
    const res = await doFetch(at(u), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as unknown;
    return { res, json };
  };
  const refused = (res: Response, json: unknown, fallback: string) => {
    const err = errorSchema.safeParse(json);
    return err.success ? new HspPaymentError(err.data.error.code, err.data.error.message, res, err.data.error.details) : new HspPaymentError(fallback, `HTTP ${res.status}`, res);
  };

  let submitted = false;
  for (let attempt = 0; attempt <= (o.maxRequotes ?? 2) && !submitted; attempt++) {
    const prep = await post(requirement.extra.prepareUrl, { payer });
    if (!prep.res.ok) throw refused(prep.res, prep.json, "PREPARE_FAILED");
    const q = preparedSchema.safeParse(prep.json);
    if (!q.success) throw new HspPaymentError("INVALID_QUOTE", "the prepare answer is not an HSP quote", prep.res);
    checkQuote(q.data, requirement, payer, chainId, o.maxAmount, prep.res);
    const signature = await o.account.signTypedData(hspAgenticTypedData(q.data.eip712 as HspEip712Json) as Parameters<LocalAccount["signTypedData"]>[0]);
    const sub = await post(requirement.extra.submitUrl, { payer, signature });
    if (sub.res.ok) submitted = true;
    else {
      const err = refused(sub.res, sub.json, "SUBMIT_FAILED");
      // An expired quote is never resubmitted: prepare a new one and sign that.
      if (!REQUOTE_CODES.has(err.code)) throw err;
    }
  }
  if (!submitted) throw new HspPaymentError("HSP_QUOTE_EXPIRED", "every HSP quote expired before it was submitted");

  const waitFor = o.waitFor ?? "paid";
  const deadline = Date.now() + (o.timeoutMs ?? 600_000);
  for (;;) {
    const res = await doFetch(at(requirement.extra.statusUrl));
    const s = statusSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !s.success) throw new HspPaymentError("STATUS_FAILED", `the status answer is HTTP ${res.status}`, res);
    const state: HspPaymentState = {
      paymentId: s.data.payment_id,
      status: s.data.status,
      flowId: s.data.flow_id ?? null,
      hspStatus: (s.data.hsp.status ?? null) as HspStatus | null,
      statusReason: s.data.hsp.status_reason ?? null,
      txHash: s.data.hsp.tx_hash ?? null,
      attributionVerified: s.data.hsp.attribution_verified === true,
    };
    if (state.hspStatus === "payment-failed") throw new HspPaymentError("HSP_PAYMENT_FAILED", state.statusReason ?? "HSP reported payment-failed", res, { ...state });
    const paid = state.status === "paid" || state.status === "overpaid";
    if (waitFor === "submitted" || (waitFor === "paid" && paid) || (waitFor === "finalized" && paid && state.hspStatus === "payment-finalized")) return { ...state, requirement };
    if (Date.now() >= deadline) throw new HspPaymentError("TIMEOUT", `still ${state.status} (HSP ${state.hspStatus ?? "unknown"}) after waiting`, res, { ...state });
    await new Promise((r) => setTimeout(r, o.pollMs ?? 3_000));
  }
}

/** The quote must pay exactly the offer: amount, forwarder, token, chain and this payer. */
function checkQuote(q: z.infer<typeof preparedSchema>, r: HspRequirement, payer: Address, chainId: number, maxAmount: bigint, res: Response) {
  const bad = (code: string, why: string) => new HspPaymentError(code, `${why}; nothing was signed`, res);
  const total = BigInt(q.token_total_raw);
  if (total > maxAmount) throw bad("MAX_AMOUNT", `HSP quoted ${total}, above maxAmount ${maxAmount}`);
  if (total !== BigInt(r.amount)) throw bad("AMOUNT_MISMATCH", `HSP quoted ${total}, the offer was ${r.amount}`);
  if (!isAddressEqual(q.recipient, r.payTo)) throw bad("PAY_TO_MISMATCH", `HSP pays ${q.recipient}, the offer named ${r.payTo}`);
  if (!isAddressEqual(q.payer, payer)) throw bad("PAYER_MISMATCH", "the quote is for another payer");
  const e = q.eip712;
  if (Number(e.domain.chainId) !== chainId) throw bad("CHAIN_MISMATCH", `the data to sign is for chain ${String(e.domain.chainId)}`);
  if (e.primaryType === "TransferWithAuthorization") {
    const m = e.message;
    const same = (a: unknown, b: Address) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && isAddressEqual(getAddress(a), b);
    if (!same(e.domain.verifyingContract, r.asset)) throw bad("ASSET_MISMATCH", "the data to sign is for another token");
    if (!same(m.from, payer) || !same(m.to, r.payTo) || String(m.value) !== r.amount) throw bad("TRANSFER_MISMATCH", "the transfer to sign does not match the offer");
  }
}
