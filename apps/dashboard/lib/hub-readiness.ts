/**
 * What the hub requires of a server before it should accept a Call, checked from the hub itself. The same two checks
 * the server runs at startup (the node's hub-readiness.ts), which it reports only in its log and its metrics:
 *
 * 1. A seller can settle a voucher itself (`settle_own`) only together with the server's acceptance, signed by a receipt
 *    key the server's account registered on the hub. A server whose key is not registered hands its sellers receipts
 *    they cannot settle with.
 * 2. `settle_batch` writes storage that is charged to a balance the server's account prepays on the hub. Once it runs
 *    out, every batch is refused with INSUFFICIENT_STORAGE.
 *
 * Pure, for tests. `use-hub-readiness.ts` does the reading.
 */
import { MAX_CLAIMS, id32Bytes, isId32, maxSettleBatchStorageCost, publicKeyToString } from "@payminto/protocol";

/**
 * The least prepaid storage a server should hold, in yoctoNEAR: what one full batch to new Payees with the longest
 * account names can cost (0.36913 NEAR). The same threshold the server and the deploy script use.
 */
export const MIN_SETTLE_STORAGE_YOCTO: bigint = maxSettleBatchStorageCost(MAX_CLAIMS);

export type HubStanding = {
  /** The receipt keys the hub holds for the server's account, in NEAR text form (`ed25519:...`). */
  receiptKeys: string[];
  /** Unused prepaid storage of the server's account on the hub, yoctoNEAR. */
  storageYocto: bigint;
};

export type HubReadinessCheck = "receipt_key_registered" | "settle_storage_balance";

export type HubReadinessProblem = {
  check: HubReadinessCheck;
  title: string;
  /** What is wrong and what follows from it. Names accounts, so set it with AccountSentence. */
  happened: string;
  /** What the operator should do. */
  todo: string;
};

/** The hub returns receipt keys as 32 bytes of hex. A value that is not one is kept as it came, so it shows as found. */
export function receiptKeyText(raw: unknown): string {
  if (isId32(raw)) return publicKeyToString(id32Bytes(raw));
  return String(raw);
}

const YOCTO_PER_NEAR = 10n ** 24n;

/** An exact NEAR figure from yoctoNEAR, with no rounding: "0.36913 NEAR", "1 NEAR", "0 NEAR". */
export function nearText(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} NEAR`;
}

/**
 * The problems in a server's standing on the hub. `nodeKey` is the key the server signs acceptances with (`nodeKey` in
 * `/v1/info`); when the server does not report one, the receipt key cannot be checked and is not reported as a problem.
 */
export function hubReadinessProblems(
  a: { operator: string; hub: string; nodeKey?: string | null },
  standing: HubStanding,
  minStorageYocto: bigint = MIN_SETTLE_STORAGE_YOCTO,
): HubReadinessProblem[] {
  const problems: HubReadinessProblem[] = [];
  if (a.nodeKey && !standing.receiptKeys.includes(a.nodeKey)) {
    const held = standing.receiptKeys.length === 0 ? "no receipt key" : standing.receiptKeys.length === 1 ? "another receipt key" : `${standing.receiptKeys.length} other receipt keys`;
    problems.push({
      check: "receipt_key_registered",
      title: "This server's receipt key is not registered on the hub",
      happened: `The hub holds ${held} for ${a.operator}. A seller can settle a voucher itself only with an acceptance signed by a registered key, so until then no seller can settle a Call this server accepts without the server.`,
      todo: `Sign register_receipt_key on ${a.hub} as ${a.operator}, with a full-access key and exactly 1 yoctoNEAR. The key to register is the receipt key shown under Settings, Network.`,
    });
  }
  if (standing.storageYocto < minStorageYocto) {
    problems.push({
      check: "settle_storage_balance",
      title: "The prepaid storage balance on the hub is low",
      happened: `${a.operator} holds ${nearText(standing.storageYocto)} of prepaid storage on the hub, below the ${nearText(minStorageYocto)} one full settlement batch can cost. Once it runs out the hub refuses every batch with INSUFFICIENT_STORAGE, and accepted Calls stay unsettled.`,
      todo: `Call fund_storage on ${a.hub} for ${a.operator} with NEAR attached. Anyone may fund it, and the unused part can be withdrawn later.`,
    });
  }
  return problems;
}
