import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { CAPABILITIES, hashkeyContracts } from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";

/** EAS schema of a confirmed settlement batch. Not revocable: a settled batch cannot be un-settled. */
export const BATCH_SCHEMA = "bytes32 batchId,bytes32 receiptsRoot,uint256 gross,uint256 net,uint256 transfers";
export const BATCH_SCHEMA_PARAMS = [
  { name: "batchId", type: "bytes32" },
  { name: "receiptsRoot", type: "bytes32" },
  { name: "gross", type: "uint256" },
  { name: "net", type: "uint256" },
  { name: "transfers", type: "uint256" },
] as const;

/** EAS schema of a confirmed gateway payment (GATEWAY.md section 13.3). Not revocable. */
export const PAYMENT_SCHEMA = "bytes32 paymentRef,bytes32 orderHash,address payer,address payout,address token,uint256 amount,bytes32 txHash";
export const PAYMENT_SCHEMA_PARAMS = [
  { name: "paymentRef", type: "bytes32" },
  { name: "orderHash", type: "bytes32" },
  { name: "payer", type: "address" },
  { name: "payout", type: "address" },
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "txHash", type: "bytes32" },
] as const;

export type PaymentAttestationData = {
  paymentRef: Hex;
  orderHash: Hex;
  payer: Address;
  payout: Address;
  token: Address;
  amount: bigint;
  txHash: Hex;
};

/** HSP capability a batch satisfies once its EAS attestation is verified on chain. */
export const ATTEST_CAPABILITY = CAPABILITIES.batchAttested;

/** EAS SchemaRegistry uid: keccak256(abi.encodePacked(schema, resolver, revocable)). */
export function schemaUid(schema = BATCH_SCHEMA, resolver: Address = zeroAddress, revocable = false): Hex {
  return keccak256(encodePacked(["string", "address", "bool"], [schema, resolver, revocable]));
}

export const schemaRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "getSchema",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "schema", type: "string" },
        ],
      },
    ],
  },
] as const;

export const easAbi = [
  {
    type: "function",
    name: "attest",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "getAttestation",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Attested",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "attester", type: "address", indexed: true },
      { name: "uid", type: "bytes32", indexed: false },
      { name: "schemaUID", type: "bytes32", indexed: true },
    ],
  },
] as const;

export type BatchAttestationData = { batchId: Hex; receiptsRoot: Hex; gross: bigint; net: bigint; transfers: bigint };

/**
 * Attests each confirmed batch on the EAS predeploy (EAS_ATTEST=true). The schema is registered on first use.
 * Recipient is the ClearingHub, attester is the node operator.
 */
export class BatchAttester {
  readonly eas: Address;
  readonly registry: Address;
  readonly schemaUid = schemaUid();
  readonly paymentSchemaUid = schemaUid(PAYMENT_SCHEMA);
  readonly #chain: ChainClient;
  readonly #ready = new Map<string, Promise<void>>();

  constructor(chain: ChainClient) {
    this.#chain = chain;
    this.eas = hashkeyContracts[177].eas;
    this.registry = hashkeyContracts[177].schemaRegistry;
  }

  /** Throws unless EAS and its SchemaRegistry exist on this chain (HashKey Chain or a fork of it). */
  async assertAvailable(): Promise<void> {
    const [eas, reg] = await Promise.all([this.#chain.isContract(this.eas), this.#chain.isContract(this.registry)]);
    if (!eas || !reg) throw new Error(`EAS_ATTEST=true but chain ${this.#chain.chainId} has no EAS predeploy at ${this.eas}`);
  }

  /** Registers a schema once (anyone may; the uid is deterministic). */
  ensureSchema(schema = BATCH_SCHEMA): Promise<void> {
    let ready = this.#ready.get(schema);
    if (!ready) {
      const uid = schemaUid(schema);
      ready = (async () => {
        const s = await this.#chain.public.readContract({ address: this.registry, abi: schemaRegistryAbi, functionName: "getSchema", args: [uid] });
        if (s.uid !== zeroHash) return;
        const r = await this.#chain.send({
          to: this.registry,
          data: encodeFunctionData({ abi: schemaRegistryAbi, functionName: "register", args: [schema, zeroAddress, false] }),
        });
        if (r.status !== "success") throw new Error(`schema registration reverted in ${r.transactionHash}`);
      })().catch((err) => {
        this.#ready.delete(schema);
        throw err;
      });
      this.#ready.set(schema, ready);
    }
    return ready;
  }

  async attest(hub: Address, d: BatchAttestationData): Promise<{ uid: Hex; txHash: Hex }> {
    const data = encodeAbiParameters(BATCH_SCHEMA_PARAMS, [d.batchId, d.receiptsRoot, d.gross, d.net, d.transfers]);
    return this.#attest(BATCH_SCHEMA, hub, data);
  }

  /** Attests a confirmed gateway payment; the recipient is the payout. */
  async attestPayment(d: PaymentAttestationData): Promise<{ uid: Hex; txHash: Hex }> {
    const data = encodeAbiParameters(PAYMENT_SCHEMA_PARAMS, [d.paymentRef, d.orderHash, d.payer, d.payout, d.token, d.amount, d.txHash]);
    return this.#attest(PAYMENT_SCHEMA, d.payout, data);
  }

  async #attest(schema: string, recipient: Address, data: Hex): Promise<{ uid: Hex; txHash: Hex }> {
    await this.ensureSchema(schema);
    const r = await this.#chain.send({
      to: this.eas,
      data: encodeFunctionData({
        abi: easAbi,
        functionName: "attest",
        args: [{ schema: schemaUid(schema), data: { recipient, expirationTime: 0n, revocable: false, refUID: zeroHash, data, value: 0n } }],
      }),
    });
    if (r.status !== "success") throw new Error(`attest reverted in ${r.transactionHash}`);
    const ev = parseEventLogs({ abi: easAbi, logs: r.logs.filter((l) => isAddressEqual(l.address, this.eas)), eventName: "Attested" })[0];
    if (!ev) throw new Error("Attested event missing");
    return { uid: ev.args.uid, txHash: r.transactionHash };
  }
}

/** Reads an attestation back and checks it is ours, for this schema and this batch (used by the local HSP verifier). */
export async function verifyBatchAttestation(
  chain: Pick<ChainClient, "public">,
  uid: Hex,
  expect: { batchId: Hex; attester: Address; hub: Address },
): Promise<boolean> {
  const eas = hashkeyContracts[177].eas;
  const a = await chain.public.readContract({ address: eas, abi: easAbi, functionName: "getAttestation", args: [uid] });
  if (a.uid === zeroHash || a.schema !== schemaUid() || a.revocationTime !== 0n) return false;
  if (!isAddressEqual(a.attester, expect.attester) || !isAddressEqual(a.recipient, expect.hub)) return false;
  const [batchId] = decodeAbiParameters(BATCH_SCHEMA_PARAMS, a.data);
  return batchId.toLowerCase() === expect.batchId.toLowerCase();
}
