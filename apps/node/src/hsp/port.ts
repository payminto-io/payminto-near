import type { Address, Hex } from "viem";
import type { HspMandateBody } from "@payminto/protocol";

export type HspSettleInput = {
  paymentId: Hex;
  body: HspMandateBody;
  /** Debtor co-signature over the HSP mandate; null when the debtor did not co-sign in time. */
  signerProof: Hex | null;
  txHash: Hex;
  batchId: Hex;
  /** Coordinator id from an earlier attempt, so retries resume instead of re-registering. */
  coordinatorId?: string | null;
  /** EAS attestation of the batch (EAS_ATTEST=true), proving the `attests:payminto-batch-settled:v1` capability. */
  attestationUid?: Hex | null;
};

export type HspSettleOutcome = {
  status: "ACCEPT" | "REJECT" | "SETTLED" | "SUBMITTED" | "FAILED" | "UNSIGNED";
  logIndex?: number | null;
  satisfied?: string[];
  receipt?: Record<string, unknown> | null;
  coordinatorId?: string | null;
  coordinatorStatus?: string | null;
  error?: string | null;
  /** True when the background worker should try again later. */
  retry?: boolean;
};

/**
 * One seam for HSP. The local adapter is our own adapter + verifier; the coordinator adapter talks to the
 * HashKey HSP Coordinator. Swapping in the official @hsp/sdk later means writing a third implementation.
 */
export interface HspPort {
  readonly mode: "local" | "coordinator";
  readonly verifyingContract: Address;
  /** Capabilities written into every HSP mandate's requiredCapabilitiesHash. */
  readonly requiredCapabilities: readonly string[];
  settle(input: HspSettleInput): Promise<HspSettleOutcome>;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}
