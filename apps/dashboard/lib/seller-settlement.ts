/**
 * A Call its seller settled itself on the hub (`settle_own`). It is settled, in no settlement batch, and has no Merkle
 * proof: there is no batch root to check. What can be checked is the hub's settled position of the Budget and Payee,
 * which must be at or past the Call's running total. Pure, for tests.
 */
import type { Call, ReceiptProof } from "./schemas";
import type { CheckState } from "./proof";

/** The one way every screen names this state. */
export const SELLER_SETTLED_LABEL = "Settled by the seller on the hub";

type CallLike = { status?: string | null; settledBy?: Call["settledBy"] };

/** True when the seller settled this Call itself, so no batch and no Merkle proof exist for it. */
export function isSellerSettled(c: CallLike | Pick<ReceiptProof, "settledBy" | "sellerSettlement">): boolean {
  return c.settledBy === "seller" || ("sellerSettlement" in c && c.sellerSettlement != null);
}

/** A Call's status in words. A seller-settled Call is settled, never waiting for a proof. */
export function callStatusLabel(c: CallLike): string {
  if (isSellerSettled(c)) return SELLER_SETTLED_LABEL;
  if (c.status === "settled") return "Settled";
  if (c.status === "settling") return "Settling";
  return "In next settlement";
}

/** Where this browser's own read of the hub's settled position stands. `none`: the page has no RPC to read from. */
export type HubPositionRead =
  | { state: "none" }
  | { state: "reading" }
  | { state: "error"; message: string }
  | { state: "done"; settled: string; blockHeight: number; source: string };

export type SellerCheckKey = "receipt" | "booked" | "position" | "server";
export type SellerCheck = { key: SellerCheckKey; label: string; state: CheckState; detail: string };

type SellerProof = Pick<ReceiptProof, "receipt" | "sellerSettlement">;

/** What the server said about the hub when the page asked, as one sentence. */
export function serverReadText(covered: boolean | null | undefined): string {
  if (covered === true) return "The server read the hub when this page asked, and the hub's settled position covers this Call.";
  if (covered === false) return "The server read the hub when this page asked, and the hub's settled position does not cover this Call.";
  return "The server could not read the hub when this page asked.";
}

/**
 * The checks behind a seller-settled Call, in the order a reader makes them. The one that decides is this browser's own
 * read of the hub; the server's read is shown next to it and can only ever lower the verdict. `money` renders an atomic
 * amount with its unit.
 */
export function sellerSettledChecks(p: SellerProof, read: HubPositionRead, money: (atomic: string) => string): SellerCheck[] {
  const s = p.sellerSettlement ?? null;
  const total = p.receipt.cumulative;
  const receipt: SellerCheck = {
    key: "receipt",
    label: "Receipt signed by the Payminto server",
    state: "pass",
    detail: "The server accepted the voucher and signed this receipt. The hub takes a voucher from its seller only together with that acceptance.",
  };
  const booked: SellerCheck = s
    ? {
        key: "booked",
        label: "Seller settlement booked by the server",
        state: "pass",
        detail: `The hub's settled position moved from ${money(s.previous)} to ${money(s.cumulative)} outside any batch of this server, and the server booked it as ${s.id}.`,
      }
    : { key: "booked", label: "Seller settlement booked by the server", state: "unknown", detail: "The server marked this Call as settled by its seller but sent no record of the settlement." };
  let position: SellerCheck;
  const label = "The hub's settled position covers this Call";
  if (read.state === "done") {
    const covers = BigInt(read.settled) >= BigInt(total);
    const where = `Read from ${read.source} at final block ${read.blockHeight.toLocaleString("en-US")}`;
    position = {
      key: "position",
      label,
      state: covers ? "pass" : "fail",
      detail: covers
        ? `${where}: the hub has settled ${money(read.settled)} to this Payee under this Budget, at or past this Call's running total of ${money(total)}.`
        : `${where}: the hub has settled ${money(read.settled)} to this Payee under this Budget, below this Call's running total of ${money(total)}.`,
    };
  } else if (read.state === "reading") {
    position = { key: "position", label, state: "pending", detail: "Reading NEAR..." };
  } else {
    position = { key: "position", label, state: "unknown", detail: read.state === "error" ? read.message : "This page has no NEAR RPC configured, so the hub was not read from this browser." };
  }
  const covered = s?.covered;
  const server: SellerCheck = {
    key: "server",
    label: "The server's own read of the hub agrees",
    state: covered === true ? "pass" : covered === false ? "fail" : "unknown",
    detail: serverReadText(covered),
  };
  return [receipt, booked, position, server];
}

export type SellerVerdict = { verdict: "verified" | "failed" | "checking" | "unreachable"; title: string; body: string };

const NO_ROOT = "The seller, this Call's Payee, settled it on the hub itself, outside any settlement batch. There is no batch root to check, so there is no Merkle proof.";

/**
 * The verdict of a seller-settled Call. It is settled in every state but one: a read of the hub, by this browser or by
 * the server, that shows a settled position below the Call. A hub that could not be read is said plainly and never
 * turns the Call into one that waits for a proof.
 */
export function sellerSettledVerdict(checks: readonly SellerCheck[], read: HubPositionRead): SellerVerdict {
  const server = checks.find((c) => c.key === "server");
  if (checks.some((c) => c.state === "fail")) {
    return {
      verdict: "failed",
      title: "The hub does not show this Call as settled",
      body: "The server booked a seller settlement for this Call, but a read of the hub shows a settled position below this Call's running total. Do not treat this Call as settled.",
    };
  }
  if (read.state === "done") {
    return { verdict: "verified", title: SELLER_SETTLED_LABEL, body: `${NO_ROOT} This browser read the hub's settled position instead, and it covers this Call.` };
  }
  if (read.state === "reading") return { verdict: "checking", title: SELLER_SETTLED_LABEL, body: `${NO_ROOT} Reading the hub's settled position from this browser.` };
  const why = read.state === "error" ? read.message : "This page has no NEAR RPC configured, so the hub was not read from this browser. Set NEXT_PUBLIC_NEAR_RPC_URL.";
  return { verdict: "unreachable", title: SELLER_SETTLED_LABEL, body: `${NO_ROOT} ${why} ${server?.detail ?? ""}`.trim() };
}
