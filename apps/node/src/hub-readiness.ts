import { maxSettleBatchStorageCost } from "@payminto/chain";
import type { ChainClient } from "./chain.ts";

/** One thing about this node's standing on the hub that would stop it from settling or from being believed. */
export type HubReadinessProblem = {
  check: "receipt_key_registered" | "settle_storage_balance";
  message: string;
};

/** Batch records the least prepaid storage balance covers. */
export const MIN_SETTLE_STORAGE_BATCHES = 100;

/**
 * The least prepaid storage balance a node should hold, in yoctoNEAR: the records of 100 batches by a settler with the
 * longest account name (0.281 NEAR). The settler pays only for its own batch records, receipt keys and checkout
 * payments, because each Budget's owner prepays its payees' settlement storage. Below it a batch may be refused.
 */
export const MIN_SETTLE_STORAGE_YOCTO = maxSettleBatchStorageCost(MIN_SETTLE_STORAGE_BATCHES);

const near = (yocto: bigint) => `${(Number(yocto / 10n ** 18n) / 1e6).toFixed(4)} NEAR`;

/**
 * What the hub requires of a settler before this node should accept a call, read from the hub itself.
 *
 * 1. `settle_own` takes a seller's voucher only with the node's acceptance, signed by a receipt key the settler
 *    registered on the hub (`register_receipt_key`, signed by the settler account with a full-access key). A node
 *    whose key (`chain.nodeKey`, from NODE_SIGNING_SEED) is not among the hub's keys for `chain.operator` hands
 *    sellers receipts their escape hatch cannot use.
 * 2. `settle_batch` storage is charged to a storage balance the settler prepays (`fund_storage`, which anyone may
 *    call for it). A node whose balance has run out accepts calls and then has every batch refused with
 *    INSUFFICIENT_STORAGE.
 *
 * `startNode` (server.ts) calls this once at startup and raises each problem as an error log line and in
 * `payminto_operator_alerts_total{kind="hub_readiness"}`. It does not stop startup or turn `/healthz` red.
 */
export async function hubReadinessProblems(chain: ChainClient, minStorageYocto: bigint = MIN_SETTLE_STORAGE_YOCTO): Promise<HubReadinessProblem[]> {
  const problems: HubReadinessProblem[] = [];
  const [keys, storage] = await Promise.all([chain.chain.receiptKeys(chain.operator), chain.chain.storageOf(chain.operator)]);
  if (!keys.includes(chain.nodeKey)) {
    problems.push({
      check: "receipt_key_registered",
      message: `this node signs acceptances with ${chain.nodeKey}, which ${chain.operator} has not registered on ${chain.hub} (the hub holds ${keys.length ? keys.join(", ") : "no receipt key"}); sellers cannot use settle_own for calls this node accepts until ${chain.operator} signs register_receipt_key`,
    });
  }
  if (storage < minStorageYocto) {
    problems.push({
      check: "settle_storage_balance",
      message: `${chain.operator} holds ${near(storage)} of prepaid storage balance on ${chain.hub}, below the ${near(minStorageYocto)} that 100 batch records cost; settle_batch is refused with INSUFFICIENT_STORAGE once it runs out, so call fund_storage for ${chain.operator}`,
    });
  }
  return problems;
}
