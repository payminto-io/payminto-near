import { getAddress, toHex, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import {
  mandateId as computeMandateId,
  mandateToJson,
  mandateTypedData,
  payeesRoot,
  policyHash,
  type Mandate,
  type Policy,
} from "@payminto/protocol";
import { z } from "zod";
import { NodeHttp } from "./node-api.ts";
import { revokeMessage } from "./util.ts";

export type OwnerClientOptions = {
  nodeUrl: string;
  chainId: number;
  hub: Address;
  /** Owner key (EOA). Contract owners sign elsewhere and call submit() with their ERC-1271 signature. */
  account: LocalAccount;
  publicClient?: PublicClient;
  /** Node ADMIN_TOKEN: POST /v1/mandates is an operator route because the operator pays openMandate gas. */
  adminToken?: string;
  fetch?: typeof fetch;
};

export type CreateMandateArgs = {
  agent: Address;
  token: Address;
  totalCap: bigint;
  validForSeconds: number;
  payees: readonly Address[];
  policy: Policy;
  /** Defaults to one minute before now, absorbing clock skew between owner, node and chain. */
  validAfter?: bigint;
  salt?: Hex;
};

const mandateCreatedSchema = z.object({ id: z.string(), status: z.string() }).loose();

/** Owner side: builds and signs mandates, and hands them to a clearing node. */
export class OwnerClient {
  readonly chainId: number;
  readonly hub: Address;
  readonly account: LocalAccount;
  readonly #o: OwnerClientOptions;

  constructor(o: OwnerClientOptions) {
    this.#o = o;
    this.chainId = o.chainId;
    this.hub = getAddress(o.hub);
    this.account = o.account;
  }

  async #now(): Promise<bigint> {
    if (this.#o.publicClient) return (await this.#o.publicClient.getBlock()).timestamp;
    return BigInt(Math.floor(Date.now() / 1000));
  }

  async createMandate(a: CreateMandateArgs): Promise<{ mandate: Mandate; mandateId: Hex; ownerSignature: Hex }> {
    if (a.totalCap <= 0n) throw new Error("totalCap must be positive");
    if (!(a.validForSeconds > 0)) throw new Error("validForSeconds must be positive");
    if (BigInt(a.policy.perCallCap) > a.totalCap) throw new Error("policy.perCallCap exceeds totalCap");
    const now = await this.#now();
    const salt = a.salt ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
    const mandate: Mandate = {
      owner: this.account.address,
      agent: getAddress(a.agent),
      token: getAddress(a.token),
      totalCap: a.totalCap,
      validAfter: a.validAfter ?? now - 60n,
      validUntil: now + BigInt(Math.floor(a.validForSeconds)),
      payeesRoot: payeesRoot(a.payees),
      policyHash: policyHash(a.policy),
      salt,
    };
    const ownerSignature = await this.account.signTypedData(mandateTypedData(this.chainId, this.hub, mandate));
    return { mandate, mandateId: computeMandateId(this.chainId, this.hub, mandate), ownerSignature };
  }

  /**
   * POST /v1/mandates: the node verifies, opens the mandate on chain (operator pays gas) and starts clearing it.
   * With `permit` (from AgentClient.signPermit) the node uses openMandateWithPermit, which also sets the agent's
   * allowance, so the agent needs no HSK and sends no transaction.
   */
  async submit(args: {
    mandate: Mandate;
    ownerSignature: Hex;
    policy: Policy;
    payees: readonly Address[];
    label: string;
    permit?: { value: bigint; deadline: bigint; signature: Hex };
  }) {
    const http = new NodeHttp(this.#o.nodeUrl, { fetch: this.#o.fetch, bearer: this.#o.adminToken });
    return http.post("/v1/mandates", mandateCreatedSchema, {
      mandate: mandateToJson(args.mandate),
      ownerSignature: args.ownerSignature,
      policy: args.policy,
      payees: args.payees.map((p) => getAddress(p)),
      label: args.label,
      ...(args.permit
        ? { permit: { value: args.permit.value.toString(), deadline: args.permit.deadline.toString(), signature: args.permit.signature } }
        : {}),
    });
  }

  /** Owner-signed revoke at the node: stops new vouchers immediately. The owner may also call revokeMandate on chain. */
  async revoke(mandateId: Hex) {
    const http = new NodeHttp(this.#o.nodeUrl, { fetch: this.#o.fetch });
    const signature = await this.account.signMessage({ message: revokeMessage(mandateId) });
    return http.post(`/v1/mandates/${mandateId.toLowerCase()}/revoke`, z.unknown(), { signature });
  }
}
