import {
  erc20Abi,
  isAddressEqual,
  parseEventLogs,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {
  CAPABILITIES,
  clearingHubAbi,
  hspDomain,
  hspPaymentId,
  hspVerify,
  isHspMandateSignedBy,
  requiredCapabilitiesHash,
  type HspMandateBody,
  type HspOutcome,
} from "@payminto/protocol";
import { errMessage, type HspPort, type HspSettleInput, type HspSettleOutcome } from "./port.ts";

export const LOCAL_REQUIRED_CAPABILITIES = [
  CAPABILITIES.settlementVerified,
  CAPABILITIES.mandateBound,
  CAPABILITIES.nettingBatch,
] as const;

export const hspReceiptTypes = {
  Receipt: [
    { name: "paymentId", type: "bytes32" },
    { name: "txHash", type: "bytes32" },
    { name: "logIndex", type: "uint256" },
    { name: "satisfiedCapabilitiesHash", type: "bytes32" },
  ],
} as const;

export type LocalHspReceipt = {
  paymentId: Hex;
  txHash: Hex;
  logIndex: number;
  satisfiedCapabilities: string[];
  adapter: Address;
  signature: Hex;
};

function receiptTypedData(chainId: number, verifyingContract: Address, r: Omit<LocalHspReceipt, "adapter" | "signature">) {
  return {
    domain: hspDomain(chainId, verifyingContract),
    types: hspReceiptTypes,
    primaryType: "Receipt" as const,
    message: {
      paymentId: r.paymentId,
      txHash: r.txHash,
      logIndex: BigInt(r.logIndex),
      satisfiedCapabilitiesHash: requiredCapabilitiesHash(r.satisfiedCapabilities),
    },
  };
}

/** What the adapter observed on chain for one HSP mandate. */
export type Observation = { settlementVerified: boolean; nettingBatch: boolean; logIndex: number | null; reason?: string };

/**
 * Observes the settlement: the tx succeeded, the hub emitted NetTransfer(batchId, payer, recipient, amount),
 * the token contract emitted the matching Transfer, and the batch is recorded on chain for this token.
 */
export function observeSettlement(
  receipt: TransactionReceipt,
  body: HspMandateBody,
  hub: Address,
  batchOnchain: { token: Address; settledAt: bigint },
): Observation {
  if (receipt.status !== "success") return { settlementVerified: false, nettingBatch: false, logIndex: null, reason: "tx reverted" };
  const payer = decodeAddressPayload(body.signer.payload);
  const recipient = decodeAddressPayload(body.recipient.payload);
  const hubLogs = receipt.logs.filter((l) => isAddressEqual(l.address, hub));
  const net = parseEventLogs({ abi: clearingHubAbi, logs: hubLogs, eventName: "NetTransfer" }).find(
    (l) =>
      (l.args.batchId as Hex).toLowerCase() === body.settlementBinding.toLowerCase() &&
      isAddressEqual(l.args.from as Address, payer) &&
      isAddressEqual(l.args.to as Address, recipient) &&
      (l.args.amount as bigint) === body.amount,
  );
  const tokenLogs = receipt.logs.filter((l) => isAddressEqual(l.address, body.token));
  const transfer = parseEventLogs({ abi: erc20Abi, logs: tokenLogs, eventName: "Transfer" }).find(
    (l) => isAddressEqual(l.args.from, payer) && isAddressEqual(l.args.to, recipient) && l.args.value === body.amount,
  );
  const settlementVerified = !!net && !!transfer;
  const nettingBatch = batchOnchain.settledAt !== 0n && isAddressEqual(batchOnchain.token, body.token);
  return {
    settlementVerified,
    nettingBatch,
    logIndex: net ? Number(net.logIndex) : null,
    reason: settlementVerified ? undefined : "no matching NetTransfer and Transfer logs",
  };
}

export function decodeAddressPayload(payload: Hex): Address {
  // abi.encode(address): 32 bytes, address in the low 20.
  return `0x${payload.slice(-40)}` as Address;
}

/**
 * Independent verifier: checks the adapter receipt signature against the pinned adapter address, that it is for
 * this mandate, and applies the HSP rule (required capabilities subset of satisfied).
 */
export async function verifyLocalReceipt(args: {
  chainId: number;
  verifyingContract: Address;
  body: HspMandateBody;
  required: readonly string[];
  receipt: LocalHspReceipt;
  pinnedAdapter: Address;
}): Promise<HspOutcome> {
  const { receipt: r } = args;
  if (hspPaymentId(args.chainId, args.verifyingContract, args.body).toLowerCase() !== r.paymentId.toLowerCase()) return "REJECT";
  if (requiredCapabilitiesHash(args.required) !== args.body.requiredCapabilitiesHash) return "REJECT";
  try {
    const signer = await recoverTypedDataAddress({ ...receiptTypedData(args.chainId, args.verifyingContract, r), signature: r.signature });
    if (!isAddressEqual(signer, args.pinnedAdapter) || !isAddressEqual(signer, r.adapter)) return "REJECT";
  } catch {
    return "REJECT";
  }
  return hspVerify(args.required, r.satisfiedCapabilities);
}

/** HSP_MODE=local: the node is the adapter (signs receipts with the operator key) and runs the verifier. */
export class LocalHspAdapter implements HspPort {
  readonly mode = "local" as const;
  readonly verifyingContract: Address;
  readonly requiredCapabilities = LOCAL_REQUIRED_CAPABILITIES;
  readonly #chainId: number;
  readonly #hub: Address;
  readonly #client: PublicClient;
  readonly #adapter: LocalAccount;
  readonly #verifyAttestation: ((uid: Hex, batchId: Hex) => Promise<boolean>) | null;

  constructor(opts: {
    chainId: number;
    hub: Address;
    verifyingContract: Address;
    publicClient: PublicClient;
    adapterAccount: LocalAccount;
    /** EAS_ATTEST=true: checks the batch attestation on chain; a valid one adds ATTEST_CAPABILITY to the satisfied set. */
    verifyAttestation?: (uid: Hex, batchId: Hex) => Promise<boolean>;
  }) {
    this.#chainId = opts.chainId;
    this.#hub = opts.hub;
    this.verifyingContract = opts.verifyingContract;
    this.#client = opts.publicClient;
    this.#adapter = opts.adapterAccount;
    this.#verifyAttestation = opts.verifyAttestation ?? null;
  }

  async settle(input: HspSettleInput): Promise<HspSettleOutcome> {
    if (!input.signerProof) return { status: "UNSIGNED" };
    try {
      const payer = decodeAddressPayload(input.body.signer.payload);
      // The hub is read at the settlement's own block: public RPCs are load-balanced, and a backend behind the receipt
      // answers "latest" with settledAt 0, which would turn a settled batch into a final REJECT. A backend that does
      // not have that block yet throws instead, and the catch below makes it a retryable FAILED.
      const txReceipt = await this.#client.getTransactionReceipt({ hash: input.txHash });
      const batch = await this.#client.readContract({ address: this.#hub, abi: clearingHubAbi, functionName: "batches", args: [input.batchId], blockNumber: txReceipt.blockNumber });
      const b = batch as readonly [Hex, Address, Address, bigint | number, bigint, bigint];
      const obs = observeSettlement(txReceipt, input.body, this.#hub, { token: b[1], settledAt: BigInt(b[3]) });
      const signed = await isHspMandateSignedBy(this.#chainId, this.verifyingContract, input.body, input.signerProof, payer);

      const satisfied: string[] = [];
      if (obs.settlementVerified) satisfied.push(CAPABILITIES.settlementVerified);
      if (signed) satisfied.push(CAPABILITIES.mandateBound);
      if (obs.nettingBatch && input.body.settlementBinding.toLowerCase() === input.batchId.toLowerCase()) {
        satisfied.push(CAPABILITIES.nettingBatch);
      }
      // Optional, not required: an extra capability a verifier may ask for. Checked on chain, never taken on trust.
      if (input.attestationUid && this.#verifyAttestation && (await this.#verifyAttestation(input.attestationUid, input.batchId))) {
        satisfied.push(CAPABILITIES.batchAttested);
      }
      const base = { paymentId: input.paymentId, txHash: input.txHash, logIndex: obs.logIndex ?? 0, satisfiedCapabilities: satisfied };
      const signature = await this.#adapter.signTypedData(receiptTypedData(this.#chainId, this.verifyingContract, base));
      const receipt: LocalHspReceipt = { ...base, adapter: this.#adapter.address, signature };
      const outcome = await verifyLocalReceipt({
        chainId: this.#chainId,
        verifyingContract: this.verifyingContract,
        body: input.body,
        required: this.requiredCapabilities,
        receipt,
        pinnedAdapter: this.#adapter.address,
      });
      return {
        status: outcome,
        logIndex: obs.logIndex,
        satisfied,
        receipt: receipt as unknown as Record<string, unknown>,
        error: outcome === "REJECT" ? (obs.reason ?? "required capabilities not satisfied") : null,
      };
    } catch (err) {
      return { status: "FAILED", error: errMessage(err), retry: true };
    }
  }
}
