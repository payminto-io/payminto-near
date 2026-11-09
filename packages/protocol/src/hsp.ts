/**
 * HSP (HashKey Settlement Protocol) wire format v1.
 *
 * The official @hsp/core package is not public at the time of writing, so this module follows the
 * wire-v1 reconstruction that two independent teams pinned with tests and settled on mainnet through
 * the official Coordinator (see research/01-hsp-hashkey-tech.md section 2.6).
 * Re-pin MANDATE_TYPEHASH_PREIMAGE against @hsp/core as soon as the organizers publish it.
 */
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  isAddressEqual,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { ZERO_BYTES32 } from "./hub.ts";

export const MANDATE_TYPEHASH_PREIMAGE =
  "Mandate(bytes32 nonce,Signer signer,bytes32 grantRef,bytes32 requirementRef,Recipient recipient,address token,uint256 amount,uint256 chainId,uint64 deadline,bytes32 settlementBinding,bytes32 requiredCapabilitiesHash)Recipient(uint8 kind,bytes payload)Signer(bytes32 profileId,bytes payload)";

export const EIP712_EOA_PROFILE: Hex = keccak256(toBytes("eip712-eoa.v1"));

export const hspTypes = {
  Mandate: [
    { name: "nonce", type: "bytes32" },
    { name: "signer", type: "Signer" },
    { name: "grantRef", type: "bytes32" },
    { name: "requirementRef", type: "bytes32" },
    { name: "recipient", type: "Recipient" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "settlementBinding", type: "bytes32" },
    { name: "requiredCapabilitiesHash", type: "bytes32" },
  ],
  Recipient: [
    { name: "kind", type: "uint8" },
    { name: "payload", type: "bytes" },
  ],
  Signer: [
    { name: "profileId", type: "bytes32" },
    { name: "payload", type: "bytes" },
  ],
} as const;

export type HspMandateBody = {
  nonce: Hex;
  signer: { profileId: Hex; payload: Hex };
  grantRef: Hex;
  requirementRef: Hex;
  recipient: { kind: number; payload: Hex };
  token: Address;
  amount: bigint;
  chainId: bigint;
  deadline: bigint;
  settlementBinding: Hex;
  requiredCapabilitiesHash: Hex;
};

/** Capabilities are typed strings verb:object:version. A verifier ACCEPTs iff required is a subset of satisfied. */
export const CAPABILITIES = {
  settlementVerified: "proves:settlement-verified:v1",
  mandateBound: "proves:payminto-mandate-bound:v1",
  nettingBatch: "proves:payminto-netting-batch:v1",
  /** The batch is attested on EAS (HashKey Chain predeploy) by the clearing node (EAS_ATTEST=true). */
  batchAttested: "attests:payminto-batch-settled:v1",
} as const;

export function hspDomain(chainId: number, verifyingContract: Address) {
  return { name: "HSP", version: "1", chainId, verifyingContract } as const;
}

export function requiredCapabilitiesHash(caps: readonly string[]): Hex {
  const norm = [...new Set(caps.map((c) => c.toLowerCase()))].sort();
  if (norm.length === 0) return ZERO_BYTES32;
  const ids = norm.map((c) => keccak256(toBytes(c)));
  return keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [ids]));
}

/**
 * Builds the HSP mandate for one net transfer of a clearing batch.
 * settlementBinding is the batch id, so the HSP payment is cryptographically tied to the vouchers it clears.
 */
export function buildNetTransferMandate(args: {
  payer: Address;
  recipient: Address;
  token: Address;
  amount: bigint;
  chainId: number;
  batchId: Hex;
  deadline: bigint;
  requiredCapabilities?: readonly string[];
}): HspMandateBody {
  return {
    nonce: keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "address" }],
        [args.batchId, args.payer, args.recipient],
      ),
    ),
    signer: { profileId: EIP712_EOA_PROFILE, payload: encodeAbiParameters([{ type: "address" }], [args.payer]) },
    grantRef: ZERO_BYTES32,
    requirementRef: ZERO_BYTES32,
    recipient: { kind: 0, payload: encodeAbiParameters([{ type: "address" }], [args.recipient]) },
    token: args.token,
    amount: args.amount,
    chainId: BigInt(args.chainId),
    deadline: args.deadline,
    settlementBinding: args.batchId,
    requiredCapabilitiesHash: requiredCapabilitiesHash(args.requiredCapabilities ?? []),
  };
}

export function hspTypedData(chainId: number, verifyingContract: Address, body: HspMandateBody) {
  return { domain: hspDomain(chainId, verifyingContract), types: hspTypes, primaryType: "Mandate" as const, message: body };
}

/** paymentId in HSP is the mandate hash. */
export function hspPaymentId(chainId: number, verifyingContract: Address, body: HspMandateBody): Hex {
  return hashTypedData(hspTypedData(chainId, verifyingContract, body));
}

export async function isHspMandateSignedBy(
  chainId: number,
  verifyingContract: Address,
  body: HspMandateBody,
  signerProof: Hex,
  payer: Address,
): Promise<boolean> {
  try {
    const who = await recoverTypedDataAddress({ ...hspTypedData(chainId, verifyingContract, body), signature: signerProof });
    return isAddressEqual(who, payer);
  } catch {
    return false;
  }
}

/** Wire JSON form used by the Coordinator REST API: amount, chainId, deadline as decimal strings. */
export function hspMandateToWire(body: HspMandateBody) {
  return { ...body, amount: body.amount.toString(), chainId: body.chainId.toString(), deadline: body.deadline.toString() };
}

export type HspWireMandate = ReturnType<typeof hspMandateToWire>;

export function hspMandateFromWire(w: HspWireMandate): HspMandateBody {
  return { ...w, amount: BigInt(w.amount), chainId: BigInt(w.chainId), deadline: BigInt(w.deadline) };
}

export type HspOutcome = "ACCEPT" | "REJECT";

/** The single HSP acceptance rule. */
export function hspVerify(required: readonly string[], satisfied: readonly string[]): HspOutcome {
  const have = new Set(satisfied.map((c) => c.toLowerCase()));
  return required.every((c) => have.has(c.toLowerCase())) ? "ACCEPT" : "REJECT";
}
