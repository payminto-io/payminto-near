import { getAddress, isAddressEqual, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { z } from "zod";
import {
  decodeHeader,
  encodeHeader,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  knownTokenDomain,
  transferAuthorizationTypedData,
  X402_VERSION,
} from "@payminto/protocol";
import { errorSchema, zAddress, zUint } from "./node-api.ts";

// Plain x402 `exact` (EIP-3009) payer, for agents with a wallet and no Payminto mandate. A mandate agent must pay with
// AgentClient (payminto-voucher) instead: only that path is checked against the owner's policy (GATEWAY.md section 3).

const exactRequirementSchema = z
  .object({
    scheme: z.literal("exact"),
    network: z.string().regex(/^eip155:\d+$/),
    asset: zAddress,
    payTo: zAddress,
    amount: zUint,
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.object({ name: z.string().min(1), version: z.string().min(1) }).loose(),
  })
  .loose();
export type ExactRequirement = z.infer<typeof exactRequirementSchema>;

const requiredSchema = z.object({ x402Version: z.literal(X402_VERSION), resource: z.unknown().optional(), accepts: z.array(z.unknown()) }).loose();

const settlementSchema = z
  .object({
    success: z.boolean(),
    network: z.string().optional(),
    paymentId: z.string().optional(),
    status: z.string().optional(),
    txHash: z.string().nullable().optional(),
    transaction: z.string().nullable().optional(),
    payer: z.string().nullable().optional(),
  })
  .loose();
/** The parsed PAYMENT-RESPONSE header. Payminto nodes add `paymentId` and `status`. */
export type ExactSettlement = z.infer<typeof settlementSchema>;

export type PayExactOptions = {
  /** The payer wallet; it signs one EIP-3009 TransferWithAuthorization and never sends a transaction. */
  account: LocalAccount;
  /** Refuse (without signing) any requirement above this many base units. */
  maxAmount: bigint;
  /** Only pay on this chain (CAIP-2 `eip155:<chainId>`). */
  chainId?: number;
  /** Only pay in this token. */
  asset?: Address;
  /** Request init for both attempts (method, headers, a replayable body). */
  init?: RequestInit;
  fetch?: typeof fetch;
};

export type ExactPayment = {
  /** The parsed PAYMENT-RESPONSE. */
  settlement: ExactSettlement;
  /** The paid response, body unread. */
  response: Response;
  requirement: ExactRequirement;
};

/** A payment payExact refused to make or the server refused to accept. `response` is the last server answer, if any. */
export class ExactPaymentError extends Error {
  readonly code: string;
  readonly response: Response | null;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, response: Response | null = null, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "ExactPaymentError";
    this.code = code;
    this.response = response;
    this.details = details;
  }
}

/**
 * Pays an x402 resource with the standard `exact` scheme: requests it, reads PAYMENT-REQUIRED, picks the `exact`
 * requirement, signs a TransferWithAuthorization of exactly its amount to its payTo (on Payminto, the payment's
 * fee-splitting deposit forwarder), retries with PAYMENT-SIGNATURE and returns the parsed PAYMENT-RESPONSE.
 * Throws ExactPaymentError when the resource asks for no payable `exact` offer, the price is above maxAmount, or the
 * retry is refused. A resource that answers without 402 is not paid and throws NOT_PAYMENT_REQUIRED.
 */
export async function payExact(url: string | URL, o: PayExactOptions): Promise<ExactPayment> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const init = o.init ?? {};
  const first = await doFetch(url, init);
  if (first.status !== 402) throw new ExactPaymentError("NOT_PAYMENT_REQUIRED", `the resource answered HTTP ${first.status} without asking for a payment`, first);

  let raw = decodeHeader<unknown>(first.headers.get(HEADER_REQUIRED));
  if (!raw) raw = await first.clone().json().catch(() => null);
  const required = requiredSchema.safeParse(raw);
  if (!required.success) throw new ExactPaymentError("INVALID_REQUIREMENTS", "the 402 carries no x402 v2 PAYMENT-REQUIRED", first);
  const offers = required.data.accepts.flatMap((a) => {
    const r = exactRequirementSchema.safeParse(a);
    if (!r.success) return [];
    if (o.chainId !== undefined && r.data.network !== `eip155:${o.chainId}`) return [];
    if (o.asset && !isAddressEqual(r.data.asset, o.asset)) return [];
    return [r.data];
  });
  const requirement = offers[0];
  if (!requirement) throw new ExactPaymentError("NO_EXACT_OFFER", "the resource offers no `exact` payment for this chain and token", first);
  const amount = BigInt(requirement.amount);
  if (amount <= 0n) throw new ExactPaymentError("INVALID_REQUIREMENTS", "the `exact` amount must be positive", first);
  if (amount > o.maxAmount) {
    throw new ExactPaymentError("MAX_AMOUNT", `price ${amount} exceeds maxAmount ${o.maxAmount}; nothing was signed`, first, { amount: amount.toString(), maxAmount: o.maxAmount.toString() });
  }

  const chainId = Number(requirement.network.slice("eip155:".length));
  // The token's own EIP-712 domain: chains.ts when the token is the network's settlement token (a requirement that
  // names another domain for it would make the token reject the signature), otherwise what the requirement states.
  const known = knownTokenDomain(chainId, requirement.asset);
  if (known && (known.name !== requirement.extra.name || known.version !== requirement.extra.version)) {
    throw new ExactPaymentError("DOMAIN_MISMATCH", `requirement names ${requirement.extra.name} v${requirement.extra.version}, the token is ${known.name} v${known.version}`, first);
  }
  const domain = { name: requirement.extra.name, version: requirement.extra.version, chainId, verifyingContract: getAddress(requirement.asset) };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const authorization = {
    from: o.account.address,
    to: getAddress(requirement.payTo),
    value: amount,
    validAfter: 0n,
    validBefore: now + BigInt(requirement.maxTimeoutSeconds),
    nonce: toHex(globalThis.crypto.getRandomValues(new Uint8Array(32))) as Hex,
  };
  const signature = await o.account.signTypedData(transferAuthorizationTypedData(domain, authorization));
  const payment = {
    x402Version: X402_VERSION,
    ...(required.data.resource !== undefined ? { resource: required.data.resource } : {}),
    accepted: requirement,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  };
  const headers = new Headers(init.headers);
  headers.set(HEADER_SIGNATURE, encodeHeader(payment));
  const paid = await doFetch(url, { ...init, headers });
  const settlement = settlementSchema.safeParse(decodeHeader<unknown>(paid.headers.get(HEADER_RESPONSE)));
  if (paid.ok && settlement.success && settlement.data.success) return { settlement: settlement.data, response: paid, requirement };
  const err = errorSchema.safeParse(await paid.clone().json().catch(() => null));
  if (err.success) throw new ExactPaymentError(err.data.error.code, err.data.error.message, paid, err.data.error.details);
  throw new ExactPaymentError("PAYMENT_FAILED", `the paid retry answered HTTP ${paid.status}${settlement.success ? "" : " without a PAYMENT-RESPONSE"}`, paid);
}
