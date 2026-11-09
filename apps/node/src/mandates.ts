import {
  BaseError,
  encodeFunctionData,
  getAddress,
  InvalidParamsRpcError,
  isAddressEqual,
  parseEventLogs,
  parseSignature,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import {
  canonicalPolicy,
  clearingHubAbi,
  isMandateSignedBy,
  mandateId as computeMandateId,
  payeesRoot,
  policyHash,
  type Mandate,
  type Policy,
} from "@payminto/protocol";
import { ApiError } from "./errors.ts";
import type { ChainClient } from "./chain.ts";
import type { Database } from "./db/database.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logger.ts";
import { nowIso, type MandateRow, type Store } from "./store.ts";

const MAX_UINT64 = 2n ** 64n - 1n;
const EXPIRY_GRACE = 3n * 86_400n;

/** EIP-2612 permit the agent signed for the hub: the node submits it with openMandateWithPermit (gasless onboarding). */
export type MandatePermit = { value: bigint; deadline: bigint; signature: Hex };

export type CreateMandateInput = {
  mandate: Mandate;
  ownerSignature: Hex;
  policy: Policy;
  payees: Address[];
  label: string;
  permit?: MandatePermit;
};

/** Message an agent or owner signs (EIP-191) to revoke without the admin token. Replays are harmless: revoke is idempotent. */
export function revokeMessage(mandateId: Hex): string {
  return `Payminto Clearing: revoke mandate ${mandateId.toLowerCase()}`;
}

export class MandateService {
  readonly #db: Database;
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #events: EventBus;
  readonly #log: Logger;
  #lastScannedBlock: bigint;

  constructor(deps: { db: Database; store: Store; chain: ChainClient; events: EventBus; log: Logger; fromBlock: bigint }) {
    this.#db = deps.db;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#events = deps.events;
    this.#log = deps.log;
    // The scan starts at the hub's deployment block (DEPLOY_BLOCK or deployments/<chainId>.json): nothing before it can
    // concern this hub, and a live chain is far too long to scan from genesis. A stored cursor behind it moves forward.
    const floor = deps.fromBlock > 0n ? deps.fromBlock - 1n : 0n;
    const stored = this.#store.getMeta("revocations_scanned_block");
    this.#lastScannedBlock = stored !== undefined && BigInt(stored) > floor ? BigInt(stored) : floor;
  }

  async create(input: CreateMandateInput): Promise<MandateRow> {
    const { chain } = this;
    const m = input.mandate;
    const id = computeMandateId(chain.chainId, chain.hub, m).toLowerCase() as Hex;
    const payees = [...new Set(input.payees.map((p) => getAddress(p)))].sort();

    if (policyHash(input.policy) !== m.policyHash.toLowerCase()) {
      throw new ApiError(400, "POLICY_HASH_MISMATCH", "policyHash(policy) does not equal mandate.policyHash");
    }
    if (payeesRoot(payees) !== m.payeesRoot.toLowerCase()) {
      throw new ApiError(400, "PAYEES_ROOT_MISMATCH", "payeesRoot(payees) does not equal mandate.payeesRoot");
    }
    if (BigInt(input.policy.perCallCap) > m.totalCap || BigInt(input.policy.dailyCap) <= 0n) {
      throw new ApiError(400, "INVALID_POLICY", "perCallCap must not exceed totalCap and dailyCap must be positive");
    }
    if (m.totalCap <= 0n || m.validUntil <= m.validAfter) {
      throw new ApiError(400, "INVALID_MANDATE", "totalCap must be positive and validUntil after validAfter");
    }
    if (m.validUntil <= BigInt(Math.floor(Date.now() / 1000))) throw new ApiError(400, "INVALID_MANDATE", "mandate already expired");
    // The hub stores validity as uint64 and rejects mandates whose expiry grace would overflow.
    if (m.validUntil > MAX_UINT64 - EXPIRY_GRACE) throw new ApiError(400, "INVALID_MANDATE", "validUntil is too far in the future");

    const existing = this.#store.mandate(id);
    if (existing && existing.status !== "pending") return existing;

    // openMandateWithPermit when the agent signed a permit, so the agent never needs HSK or a transaction.
    let openCall: { functionName: "openMandate"; args: readonly [Mandate, Hex] } | {
      functionName: "openMandateWithPermit";
      args: readonly [Mandate, Hex, bigint, bigint, number, Hex, Hex];
    } = { functionName: "openMandate", args: [m, input.ownerSignature] };
    if (input.permit) {
      let sig;
      try {
        sig = parseSignature(input.permit.signature);
      } catch {
        throw new ApiError(400, "BAD_PERMIT", "permit.signature is not a 65-byte signature");
      }
      if (input.permit.deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new ApiError(400, "BAD_PERMIT", "permit.deadline has passed");
      const v = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27;
      openCall = {
        functionName: "openMandateWithPermit",
        args: [m, input.ownerSignature, input.permit.value, input.permit.deadline, v, sig.r, sig.s],
      };
    }

    const eoaOk = await isMandateSignedBy(chain.chainId, chain.hub, m, input.ownerSignature);
    const onchain = await chain.mandate(id);
    if (!eoaOk && !onchain) {
      // Contract owners (for example a Safe): ERC-1271 is checked by the hub itself, so simulate openMandate.
      const isContract = await chain.isContract(m.owner).catch(() => false);
      if (!isContract) throw new ApiError(400, "BAD_OWNER_SIGNATURE", "ownerSignature is not a valid signature by mandate.owner");
      await chain.public
        .simulateContract({
          address: chain.hub,
          abi: clearingHubAbi,
          ...openCall,
          account: chain.operator,
        } as Parameters<typeof chain.public.simulateContract>[0])
        .catch(() => {
          throw new ApiError(400, "BAD_OWNER_SIGNATURE", "openMandate simulation rejected the contract owner signature");
        });
    }

    if (!existing) {
      this.#db.run(
        `INSERT INTO mandates (id, owner, agent, token, total_cap, valid_after, valid_until, payees_root, policy_hash, salt,
                               owner_signature, policy, payees, label, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        id,
        getAddress(m.owner),
        getAddress(m.agent),
        getAddress(m.token),
        m.totalCap.toString(),
        Number(m.validAfter),
        Number(m.validUntil),
        m.payeesRoot.toLowerCase(),
        m.policyHash.toLowerCase(),
        m.salt.toLowerCase(),
        input.ownerSignature,
        canonicalPolicy(input.policy),
        JSON.stringify(payees),
        input.label,
        nowIso(),
      );
    }

    let txHash: Hex | null = null;
    if (!onchain) {
      const data = encodeFunctionData({ abi: clearingHubAbi, ...openCall } as Parameters<typeof encodeFunctionData>[0]);
      try {
        // Simulate first so a bad permit or signature is a clear 400, not a reverted transaction.
        await chain.public.call({ account: chain.operator, to: chain.hub, data }).catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          if (/PermitFailed|0xb78cb0dd/.test(reason)) {
            throw new ApiError(400, "BAD_PERMIT", "openMandateWithPermit: the permit failed and the agent's allowance does not cover permit.value");
          }
          throw err;
        });
        const rcpt = await chain.send({ to: chain.hub, data });
        txHash = rcpt.transactionHash;
        if (rcpt.status !== "success") throw new Error(`${openCall.functionName} reverted in ${txHash}`);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // Another submitter may have opened it concurrently; the chain is the source of truth.
        if (!(await chain.mandate(id))) {
          this.#log.error("openMandate failed", { mandateId: id, err });
          throw new ApiError(502, "OPEN_MANDATE_FAILED", "Submitting openMandate on chain failed", {
            reason: err instanceof Error ? err.message.split("\n")[0] : String(err),
          });
        }
      }
    }
    const row = this.#db.tx(() => {
      this.#db.run("UPDATE mandates SET status = 'open', open_tx_hash = ? WHERE id = ? AND status = 'pending'", txHash, id);
      const r = this.#store.mandate(id)!;
      this.#events.emit("mandate.opened", { mandate: this.#store.mandateSummary(r, Math.floor(Date.now() / 1000)) });
      return r;
    });
    this.#log.info("mandate opened", { mandateId: id, agent: row.agent, txHash, permit: !!input.permit });
    return row;
  }

  get chain(): ChainClient {
    return this.#chain;
  }

  /** Verifies an agent- or owner-signed revoke request; returns the signer role. */
  async authorizeSignedRevoke(m: MandateRow, signature: Hex): Promise<"agent" | "owner"> {
    let signer: Address;
    try {
      signer = await recoverMessageAddress({ message: revokeMessage(m.id), signature });
    } catch {
      throw new ApiError(401, "BAD_REVOKE_SIGNATURE", "signature does not recover");
    }
    if (isAddressEqual(signer, m.agent)) return "agent";
    if (isAddressEqual(signer, m.owner)) return "owner";
    // ERC-1271 owner wallets.
    const ok = await this.#chain.public
      .verifyMessage({ address: m.owner, message: revokeMessage(m.id), signature })
      .catch(() => false);
    if (ok) return "owner";
    throw new ApiError(403, "BAD_REVOKE_SIGNATURE", "revoke must be signed by the mandate agent or owner");
  }

  /**
   * Stops new vouchers immediately. Submits revokeMandate when the operator key is the owner or agent
   * (the only senders the hub accepts); otherwise returns the call the owner should make.
   */
  async revoke(id: Hex, by: string) {
    const chain = this.#chain;
    const m = this.#store.mandate(id);
    if (!m) throw new ApiError(404, "NOT_FOUND", "mandate not found");
    const first = m.status !== "revoked";
    if (first) {
      this.#db.tx(() => {
        this.#db.run("UPDATE mandates SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?", nowIso(), by, m.id);
        this.#events.emit("mandate.revoked", { mandate: this.#store.mandateSummary(this.#store.mandate(m.id)!, Math.floor(Date.now() / 1000)) });
      });
    }
    const call = {
      to: chain.hub,
      functionName: "revokeMandate",
      args: [m.id],
      data: encodeFunctionData({ abi: clearingHubAbi, functionName: "revokeMandate", args: [m.id] }),
      allowedSenders: [m.owner, m.agent],
    };
    let txHash: Hex | null = m.revoke_tx_hash;
    let submitted = false;
    const onchain = await chain.mandate(m.id).catch(() => null);
    const operatorMay = isAddressEqual(chain.operator.address, m.owner) || isAddressEqual(chain.operator.address, m.agent);
    if (onchain && onchain.revokedAt === 0n && operatorMay) {
      txHash = (await chain.send({ to: chain.hub, data: call.data })).transactionHash;
      this.#db.run("UPDATE mandates SET revoke_tx_hash = ? WHERE id = ?", txHash, m.id);
      submitted = true;
    }
    return {
      mandate: this.#store.mandateSummary(this.#store.mandate(m.id)!, Math.floor(Date.now() / 1000)),
      onchain: {
        revoked: !!onchain && (onchain.revokedAt !== 0n || submitted),
        submitted,
        txHash,
        call: submitted || (onchain && onchain.revokedAt !== 0n) ? null : call,
      },
    };
  }

  /** First block the next revocation scan will read. */
  get nextScanBlock(): bigint {
    return this.#lastScannedBlock + 1n;
  }

  /**
   * Picks up revocations made directly on chain by owners or agents. Reads at most `maxWindows` windows of 5,001 blocks
   * (the HashKey Chain eth_getLogs limit) per call, so a node far behind catches up over a few ticks.
   */
  async scanRevocations(maxWindows = 20): Promise<void> {
    // Only up to the finality head (CONFIRM_TAG, safe on HashKey Chain): a revocation in a block that can still reorg
    // is picked up a few seconds later, well inside the hub's one-hour revoke grace.
    const head = await this.#chain.headOf();
    try {
      for (let i = 0; i < maxWindows && head > this.#lastScannedBlock; i++) await this.#scanWindow(head);
    } catch (err) {
      // A load-balanced RPC answered the head from one backend and the logs from one behind it; the cursor did not
      // move, so the next tick (15 s, far inside the one-hour revoke grace) scans the same window again.
      if (!(err instanceof BaseError && err.walk((e) => e instanceof InvalidParamsRpcError))) throw err;
      this.#log.debug("revocation scan: RPC backend behind the head, retrying next tick", { head: head.toString() });
    }
  }

  async #scanWindow(head: bigint): Promise<void> {
    const chain = this.#chain;
    const from = this.#lastScannedBlock + 1n;
    const to = head - from > 5_000n ? from + 5_000n : head;
    const logs = await chain.public.getLogs({
      address: chain.hub,
      event: clearingHubAbi.find((x) => x.type === "event" && x.name === "MandateRevoked") as Extract<
        (typeof clearingHubAbi)[number],
        { type: "event"; name: "MandateRevoked" }
      >,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of parseEventLogs({ abi: clearingHubAbi, logs, eventName: "MandateRevoked" })) {
      const id = (log.args.mandateId as Hex).toLowerCase() as Hex;
      const m = this.#store.mandate(id);
      if (m && m.status !== "revoked") {
        this.#db.tx(() => {
          this.#db.run(
            "UPDATE mandates SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_tx_hash = ? WHERE id = ?",
            nowIso(),
            `chain:${getAddress(log.args.by as Address)}`,
            log.transactionHash,
            id,
          );
          this.#events.emit("mandate.revoked", { mandate: this.#store.mandateSummary(this.#store.mandate(id)!, Math.floor(Date.now() / 1000)) });
        });
        this.#log.info("mandate revoked on chain", { mandateId: id });
      }
    }
    this.#lastScannedBlock = to;
    this.#store.setMeta("revocations_scanned_block", to.toString());
  }
}

