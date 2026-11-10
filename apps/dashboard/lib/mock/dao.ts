/**
 * A Sputnik DAO v2 in memory, for NEXT_PUBLIC_MOCK: the views the dashboard reads (`get_policy`,
 * `get_last_proposal_id`, `get_proposals`) and the two calls a member signs (`add_proposal`, `act_proposal`), with the
 * contract's own rules and panics: the exact bond, the policy's permissions, the stored kind on a vote, one vote per
 * account, the voting period, and running the proposal when approvals reach the threshold. Nothing reaches a chain.
 *
 * Proposals are stored as the contract returns them, and every kind is built with the add-on's builders.
 */
import { canonicalJson, type AccountId, type WalletTx } from "@payminto/protocol";
import { approvalsNeeded, daoAbility, innerTx, type DaoAddon, type DaoPolicy, type DaoProposal, type FunctionCallKind } from "../dao";
import { MockPanic, type MockView } from "./rpc";
import type { MockTxOutcome } from "./server";

export const DEMO_DAO: AccountId = "northwind-ops.sputnik-v2.testnet";
/** The demo wallet's own account is the first member; the others let a second approval be played. */
export const DEMO_DAO_COUNCIL: AccountId[] = ["treasury.testnet", "ops-lead.testnet", "finance-desk.testnet"];
/** An account the demo wallet can switch to that is in no role of the DAO. */
export const DEMO_OUTSIDER: AccountId = "contractor-jo.testnet";

const DAY_NS = 86_400_000_000_000n;

const POLICY: DaoPolicy = {
  roles: [
    { name: "council", kind: { Group: DEMO_DAO_COUNCIL }, permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: "100000000000000000000000",
  proposal_period: (7n * DAY_NS).toString(),
};

type Stored = Omit<DaoProposal, "id">;
export type SeedProposal = { proposer: AccountId; description: string; kind: FunctionCallKind; status: DaoProposal["status"]; votes: Record<AccountId, "Approve" | "Reject">; submittedMs: number };

const ns = (ms: number) => (BigInt(Math.floor(ms)) * 1_000_000n).toString();

export class MockDao {
  readonly account = DEMO_DAO;
  readonly policy = POLICY;
  readonly #proposals: Stored[] = [];
  readonly #run: (tx: WalletTx, signer: AccountId) => MockTxOutcome;
  readonly #loadAddon: () => Promise<DaoAddon>;
  readonly #seed: (addon: DaoAddon) => SeedProposal[];
  #ready: Promise<DaoAddon> | null = null;

  /** `run` applies an approved proposal's call to the demo hub with the DAO as the caller. */
  constructor(o: { run: (tx: WalletTx, signer: AccountId) => MockTxOutcome; seed: (addon: DaoAddon) => SeedProposal[]; addon?: () => Promise<DaoAddon> }) {
    this.#run = o.run;
    this.#seed = o.seed;
    this.#loadAddon = o.addon ?? (async () => (await import("@payminto/near-addons")).dao);
  }

  /** Loads the add-on and files the seed proposals once. */
  ready(): Promise<DaoAddon> {
    this.#ready ??= this.#loadAddon().then((addon) => {
      for (const s of this.#seed(addon)) {
        this.#proposals.push({ proposer: s.proposer, description: s.description, kind: s.kind, status: s.status, votes: s.votes, vote_counts: this.#counts(s.votes), submission_time: ns(s.submittedMs) });
      }
      return addon;
    });
    return this.#ready;
  }

  #counts(votes: Record<string, string>): Record<string, string[]> {
    const of = (v: string) => Object.values(votes).filter((x) => x === v).length.toString();
    return Object.keys(votes).length === 0 ? {} : { council: [of("Approve"), of("Reject"), of("Remove")] };
  }

  readonly view: MockView = async (method, args) => {
    await this.ready();
    switch (method) {
      case "get_policy":
        return this.policy;
      case "version":
        return "2.0.0";
      case "get_last_proposal_id":
        return this.#proposals.length;
      case "get_proposals": {
        const from = Number(args.from_index ?? 0);
        const limit = Number(args.limit ?? 0);
        return this.#proposals.slice(from, from + limit).map((p, i) => ({ id: from + i, ...p }));
      }
      case "get_proposal": {
        const p = this.#proposals[Number(args.id)];
        if (!p) throw new MockPanic("ERR_NO_PROPOSAL");
        return { id: Number(args.id), ...p };
      }
      case "delegation_balance_of":
        return "0";
      default:
        throw new MockPanic(`MethodResolveError(MethodNotFound) ${method}`);
    }
  };

  /** A transaction a member's wallet sent to the DAO. Null for anything not addressed to it. */
  async apply(tx: WalletTx, signer: AccountId, nowMs = Date.now()): Promise<MockTxOutcome | null> {
    if (tx.receiverId !== this.account) return null;
    const addon = await this.ready();
    const call = tx.actions[0];
    if (!call) return { ok: false, error: "The transaction has no action." };
    const panic = (code: string): MockTxOutcome => ({ ok: false, error: `Smart contract panicked: ${code}` });
    const ability = daoAbility(this.policy, signer);
    const { methodName, args, deposit } = call.params;

    if (methodName === "add_proposal") {
      const proposal = args.proposal as { description?: unknown; kind?: FunctionCallKind } | undefined;
      if (!proposal?.kind || typeof proposal.description !== "string") return panic("ERR_INVALID_PROPOSAL");
      if (!ability.canPropose) return panic("ERR_PERMISSION_DENIED");
      if (deposit !== this.policy.proposal_bond) return panic("ERR_MIN_BOND");
      this.#proposals.push({ proposer: signer, description: proposal.description, kind: proposal.kind, status: "InProgress", vote_counts: {}, votes: {}, submission_time: ns(nowMs) });
      return { ok: true };
    }

    if (methodName === "act_proposal") {
      const p = this.#proposals[Number(args.id)];
      if (!p) return panic("ERR_NO_PROPOSAL");
      const action = String(args.action);
      if (action !== "VoteApprove" && action !== "VoteReject") return panic("ERR_WRONG_ACTION");
      if (!(action === "VoteApprove" ? ability.canApprove : ability.canReject)) return panic("ERR_PERMISSION_DENIED");
      if (canonicalJson(args.proposal) !== canonicalJson(p.kind)) return panic("ERR_WRONG_KIND");
      if (p.status !== "InProgress") return panic("ERR_PROPOSAL_NOT_READY_FOR_VOTE");
      if (p.votes[signer]) return panic("ERR_ALREADY_VOTED");
      const closesNs = BigInt(p.submission_time) + BigInt(this.policy.proposal_period);
      if (closesNs < BigInt(nowMs) * 1_000_000n) {
        // As the contract: past the period the vote is recorded as nothing and the proposal is marked expired.
        p.status = "Expired";
        return { ok: true };
      }
      p.votes = { ...p.votes, [signer]: action === "VoteApprove" ? "Approve" : "Reject" };
      p.vote_counts = this.#counts(p.votes);
      const needed = approvalsNeeded(this.policy)[0]?.needed ?? 1;
      const count = (v: string) => Object.values(p.votes).filter((x) => x === v).length;
      if (count("Approve") >= needed) {
        const outcome = this.#run(innerTx(addon, p.kind as FunctionCallKind), this.account);
        p.status = outcome.ok ? "Approved" : "Failed";
      } else if (count("Reject") >= needed) {
        p.status = "Rejected";
      }
      return { ok: true };
    }
    return panic(`MethodResolveError(MethodNotFound) ${methodName}`);
  }
}
