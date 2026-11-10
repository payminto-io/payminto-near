/**
 * Payment proof checks for /receipt/{id}: the node's claims about a checkout payment, re-checked in this browser.
 * On NEAR a checkout payment is one `ft_transfer_call` the hub records under the payment id of the node-signed terms,
 * so the checks are: the transaction is final, the hub holds the record, the record pays the merchant the amount
 * claimed, and the order the node serves hashes to the committed fingerprint.
 *
 * Chain reads go through `NearReader`: plain fetch JSON-RPC from this browser at final finality. Without one every chain
 * check is reported as skipped, never as passed, so a receipt is never shown as verified on the node's word alone. A
 * read that does not finish throws `NearReadError`; the page says so and offers to read again.
 */
import { canonicalJson, sha256Text, type ChainPayment, type Id32, type NearReader } from "@payminto/protocol";
import type { IntentsProof, OrderCommitment, PaymentProof } from "./schemas";

/** The order as the node served it: the exact bytes that were hashed, and the parsed object for display. */
export type ServedOrder = { raw: string; order: OrderCommitment };

export type CheckState = "pass" | "fail" | "skip";
export type ProofCheck = { id: string; label: string; state: CheckState; detail: string };

/** `read` says where the chain checks read from, when they did. */
export type ProofResult = { checks: ProofCheck[]; read: { rpcUrl: string; hub: string; blockHeight: number | null } | null };

/** The chain reads a payment proof needs. */
export type PaymentReader = Pick<NearReader, "payments" | "txState" | "rpcUrl" | "hub">;

/**
 * The read a payment paid from another chain needs, on the network the USDC landed on (NEAR mainnet live; the local
 * chain when simulated), which is not always the hub's.
 */
export type DeliveryReader = Pick<NearReader, "txTransfers" | "rpcUrl">;

const CHECK_IDS = ["tx", "record", "transfer", "order"] as const;
const INTENTS_CHECK_IDS = ["delivery", "delivered", "order"] as const;

/** The order fingerprint: sha256 of the exact canonical order bytes the node served, as hex. */
export const orderFingerprint = (raw: string): Id32 => sha256Text(raw);

const NO_READER = "This page has no NEAR RPC configured, so the chain was not checked.";

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/**
 * Runs every check that can run. A check that could not run is "skip"; only a check that ran and matched is "pass".
 * A payment paid from another chain (`proof.intents`) is checked by its NEAR delivery through `delivery`, never by a
 * hub record: it has none.
 */
export async function runProofChecks(proof: PaymentProof, served: ServedOrder | null, reader: PaymentReader | null, delivery: DeliveryReader | null = null): Promise<ProofResult> {
  if (proof.intents) {
    const checks = await deliveryChecks(proof.intents, delivery);
    checks.push(orderCheck(proof, served));
    return { checks, read: delivery ? { rpcUrl: delivery.rpcUrl, hub: reader?.hub ?? proof.hub ?? "", blockHeight: null } : null };
  }
  const checks: ProofCheck[] = [];

  let blockHeight: number | null = null;
  // 1. The transaction NEAR executed. NEAR looks a transaction up by its hash and its signer, the payer.
  if (!proof.tx_hash) checks.push({ id: "tx", label: "Transaction is final", state: "skip", detail: "No transaction was reported for this payment; the hub's own record below is the evidence." });
  else if (!reader) checks.push({ id: "tx", label: "Transaction is final", state: "skip", detail: NO_READER });
  else if (!proof.payer) checks.push({ id: "tx", label: "Transaction is final", state: "skip", detail: "The server named no payer, and NEAR finds a transaction only by its hash and signer." });
  else {
    const s = await reader.txState(proof.tx_hash, proof.payer);
    checks.push(
      s.status === "final"
        ? { id: "tx", label: "Transaction is final", state: "pass", detail: `${proof.tx_hash} is final on NEAR.` }
        : { id: "tx", label: "Transaction is final", state: "fail", detail: s.status === "failed" ? `NEAR reports it failed: ${s.error}` : `NEAR reports it as ${s.status}, not final.` },
    );
  }

  // 2 and 3. The hub's record of the payment, and what it pays to whom.
  let record: ChainPayment | null = null;
  if (!proof.hub_payment_id) {
    checks.push({ id: "record", label: "The hub recorded the payment", state: "fail", detail: "The server names no hub payment id." });
  } else if (!reader) {
    checks.push({ id: "record", label: "The hub recorded the payment", state: "skip", detail: NO_READER });
  } else {
    const read = await reader.payments([proof.hub_payment_id]);
    blockHeight = read.blockHeight;
    record = read.value[0] ?? null;
    checks.push(
      record
        ? { id: "record", label: "The hub recorded the payment", state: "pass", detail: `Payment ${proof.hub_payment_id} is on the hub.` }
        : { id: "record", label: "The hub recorded the payment", state: "fail", detail: `The hub has no payment ${proof.hub_payment_id}.` },
    );
  }
  if (!record) {
    checks.push({ id: "transfer", label: "Paid to the merchant", state: reader && proof.hub_payment_id ? "fail" : "skip", detail: reader && proof.hub_payment_id ? "There is no hub record to compare." : NO_READER });
  } else {
    const claimed = BigInt(proof.credit_amount ?? proof.amount_paid);
    const okMerchant = same(record.merchant, proof.payout);
    const okAmount = record.amount === claimed;
    const okPayer = !proof.payer || same(record.payer, proof.payer);
    const ok = okMerchant && okAmount && okPayer;
    const why = !okMerchant ? `the hub credited ${record.merchant}, not ${proof.payout}` : !okAmount ? `the hub recorded ${record.amount} base units, the server claims ${claimed}` : `the hub names payer ${record.payer}, the server claims ${proof.payer}`;
    checks.push({ id: "transfer", label: "Paid to the merchant", state: ok ? "pass" : "fail", detail: ok ? `${record.amount} base units credited to ${record.merchant} by ${record.payer}.` : `Mismatch: ${why}.` });
  }

  // 4. The order: hashed here from the bytes the node served, which must also be the canonical form of the order.
  checks.push(orderCheck(proof, served));
  return { checks, read: reader ? { rpcUrl: reader.rpcUrl, hub: reader.hub, blockHeight } : null };
}

function orderCheck(proof: PaymentProof, served: ServedOrder | null): ProofCheck {
  if (!served) return { id: "order", label: "Order matches its fingerprint", state: "fail", detail: "The order could not be loaded." };
  const recomputed = orderFingerprint(served.raw);
  const canonical = canonicalJson(served.order) === served.raw;
  const ok = canonical && recomputed === proof.order_hash.replace(/^0x/, "").toLowerCase() && served.order.payment_id === proof.payment_id;
  return {
    id: "order",
    label: "Order matches its fingerprint",
    state: ok ? "pass" : "fail",
    detail: ok
      ? "Hashed in this browser from the canonical order the server served."
      : !canonical
        ? "The served order is not in canonical form."
        : `Hashed to ${recomputed.slice(0, 12)}..., the server claims ${proof.order_hash.slice(0, 12)}...`,
  };
}

/**
 * A payment paid from another chain: the NEAR delivery transaction, read in this browser, is final, and its successful
 * receipts carry the USDC contract's NEP-141 `ft_transfer` to the business's account for at least the amount.
 */
async function deliveryChecks(i: IntentsProof, delivery: DeliveryReader | null): Promise<ProofCheck[]> {
  const where = settlementName(i.settlement_network);
  const skip = (id: string, label: string, detail: string): ProofCheck => ({ id, label, state: "skip", detail });
  if (!i.delivery_tx) return [{ id: "delivery", label: "Delivery is final", state: "fail", detail: "The server names no delivery transaction." }, skip("delivered", "USDC delivered to the business", "There is no delivery to read.")];
  const hash = i.delivery_tx.hash;
  if (!delivery) {
    const why = `This page has no RPC for ${where}, so the delivery was not checked.`;
    return [skip("delivery", "Delivery is final", why), skip("delivered", "USDC delivered to the business", why)];
  }
  const read = await delivery.txTransfers(hash, i.delivery_senders);
  if (read.status !== "final") {
    const why = read.status === "failed" ? `NEAR reports the delivery failed: ${read.error}` : read.status === "pending" ? "NEAR reports the delivery as not final yet." : `${where} does not know ${hash} under any of the accounts the server named.`;
    return [
      { id: "delivery", label: "Delivery is final", state: "fail", detail: why },
      { id: "delivered", label: "USDC delivered to the business", state: "fail", detail: "There is no final delivery to compare." },
    ];
  }
  const total = read.transfers.filter((t) => t.token === i.token && t.to === i.recipient).reduce((sum, t) => sum + t.amount, 0n);
  const due = BigInt(i.amount);
  return [
    { id: "delivery", label: "Delivery is final", state: "pass", detail: `${hash} is final on ${where} (found under ${read.sender}).` },
    total >= due
      ? { id: "delivered", label: "USDC delivered to the business", state: "pass", detail: `${total} base units of ${i.token} transferred to ${i.recipient} (NEP-141 ft_transfer).` }
      : { id: "delivered", label: "USDC delivered to the business", state: "fail", detail: `The delivery transferred ${total} base units of ${i.token} to ${i.recipient}; the payment needs ${due}.` },
  ];
}

/** "NEAR mainnet", or the local chain that stands in for it when the server runs the any-chain checkout simulated. */
export function settlementName(settlement: string): string {
  return settlement === "near:mainnet" ? "NEAR mainnet" : settlement.startsWith("near:mainnet") ? "the local chain (simulated mainnet)" : settlement;
}

/** The checks runProofChecks produces, in order, so the page can list them before they finish. */
export function expectedCheckIds(proof?: Pick<PaymentProof, "intents"> | null): string[] {
  return proof?.intents ? [...INTENTS_CHECK_IDS] : [...CHECK_IDS];
}

/** One sentence a non-technical reader understands, per check; the technical detail stays in its own line. */
export function plainCheckTitle(id: string, ctx: { merchant: string; network: string }): string {
  switch (id) {
    case "tx":
      return `The payment is final on ${ctx.network}`;
    case "record":
      return "The payment hub recorded it";
    case "transfer":
      return `The hub credited it to ${ctx.merchant}`;
    case "order":
      return "The order matches what was bought";
    case "delivery":
      return `The delivery is final on ${ctx.network}`;
    case "delivered":
      return `The USDC reached ${ctx.merchant}'s NEAR account`;
    default:
      return id;
  }
}

export type ProofVerdict = { state: "verified" | "unverified" | "failed"; passed: number; run: number; skipped: number; failed: number };

/** Counts only checks that ran; a skipped check never counts as passed, and "verified" needs every check to have run. */
export function proofVerdict(checks: readonly ProofCheck[]): ProofVerdict {
  const run = checks.filter((c) => c.state !== "skip");
  const failed = run.filter((c) => c.state === "fail").length;
  const skipped = checks.length - run.length;
  return { state: failed > 0 || run.length === 0 ? "failed" : skipped > 0 ? "unverified" : "verified", passed: run.length - failed, run: run.length, skipped, failed };
}
