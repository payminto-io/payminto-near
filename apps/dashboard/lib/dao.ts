/**
 * A Sputnik DAO v2 as the owner of a Budget. The DAO's policy and proposals are read with the read-only NEAR reader
 * and parsed here; every transaction (add_proposal, act_proposal) and every decode comes from the add-on's builders in
 * `@payminto/near-addons`, never from JSON written by hand. Pure, for tests; the add-on module is passed in.
 *
 * Views used, as in sputnik-dao-contract `sputnikdao2/src/views.rs`: `get_policy()`, `get_last_proposal_id()` and
 * `get_proposals({ from_index, limit })`. A proposal is `{ id, proposer, description, kind, status, vote_counts,
 * votes, submission_time }`; `proposal_period` and `submission_time` are nanoseconds as decimal strings.
 */
import { z } from "zod";
import { budgetIdOf, id32Bytes, isAccountId, isId32, publicKeyToString, type AccountId, type BudgetTerms, type Id32, type Network, type WalletTx } from "@payminto/protocol";
import { formatMoney } from "./format";

export type DaoAddon = typeof import("@payminto/near-addons").dao;
export type FunctionCallKind = Parameters<DaoAddon["voteTx"]>[2];

// ---------------------------------------------------------------------------------------------------------------------
// Which accounts are DAOs

/** The Sputnik v2 factory per network. Its DAOs are `<name>.<factory>`. A local sandbox has none. */
const FACTORY: Partial<Record<Network, string>> = { "near:testnet": "sputnik-v2.testnet", "near:mainnet": "sputnik-dao.near" };

export const daoFactory = (network: Network): string | null => FACTORY[network] ?? null;

/** True for `<name>.sputnik-v2.testnet` on testnet, where `<name>` has no dot of its own. */
export function isDaoAccount(account: string | null | undefined, network: Network): boolean {
  const factory = daoFactory(network);
  if (!factory || !account || !isAccountId(account) || !account.endsWith(`.${factory}`)) return false;
  const name = account.slice(0, -factory.length - 1);
  return name.length > 0 && !name.includes(".");
}

/** What is wrong with a DAO account someone typed, or null. */
export function daoAccountError(value: string, network: Network): string | null {
  const factory = daoFactory(network);
  if (!factory) return "This network has no Sputnik DAO factory.";
  const v = value.trim();
  if (!v) return `Enter the DAO's account, for example my-team.${factory}.`;
  if (!isDaoAccount(v, network)) return `A DAO on this network is named like my-team.${factory}.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Policy

const u128 = z.string().regex(/^(0|[1-9][0-9]*)$/);

const roleKindSchema = z.union([z.literal("Everyone"), z.object({ Group: z.array(z.string()) }), z.object({ Member: u128 })]);

const votePolicySchema = z.object({
  weight_kind: z.enum(["RoleWeight", "TokenWeight"]),
  quorum: u128,
  /** A fixed weight, or a ratio `[numerator, denominator]` of the role's size. */
  threshold: z.union([u128, z.tuple([z.number().int().nonnegative(), z.number().int().positive()])]),
});

const roleSchema = z.object({
  name: z.string(),
  kind: roleKindSchema,
  permissions: z.array(z.string()),
  vote_policy: z.record(z.string(), votePolicySchema).default({}),
});

export const daoPolicySchema = z.object({
  roles: z.array(roleSchema),
  default_vote_policy: votePolicySchema,
  proposal_bond: u128,
  proposal_period: u128,
});
export type DaoPolicy = z.infer<typeof daoPolicySchema>;
type Role = z.infer<typeof roleSchema>;

/** Budget actions are FunctionCall proposals, which the policy names "call". */
const KIND_LABEL = "call";

export type DaoAction = "AddProposal" | "VoteApprove" | "VoteReject";

/** As `Policy::can_execute_action`: the exact pair, either wildcard, or both. */
const allows = (role: Role, action: DaoAction): boolean =>
  role.permissions.includes(`${KIND_LABEL}:${action}`) || role.permissions.includes(`${KIND_LABEL}:*`) || role.permissions.includes(`*:${action}`) || role.permissions.includes("*:*");

function matches(role: Role, account: AccountId, delegated: bigint | null): boolean | null {
  if (role.kind === "Everyone") return true;
  if ("Group" in role.kind) return role.kind.Group.includes(account);
  // A token-weighted role: membership is the account's delegated stake, which is unknown until it is read.
  return delegated === null ? null : delegated >= BigInt(role.kind.Member);
}

export type DaoAbility = {
  /** Named in a group role, or holding enough stake for a token role. */
  member: boolean;
  /** The roles that matched, by name. */
  roles: string[];
  canPropose: boolean;
  canApprove: boolean;
  canReject: boolean;
  /** A token role could not be judged because the stake was not read; the answers above may be too strict. */
  uncertain: boolean;
};

/**
 * What `account` may do with Budget proposals under this policy. `delegated` is its staked balance for token roles
 * (`delegation_balance_of`), or null when it was not read.
 */
export function daoAbility(policy: DaoPolicy, account: AccountId | null, delegated: bigint | null = null): DaoAbility {
  const out: DaoAbility = { member: false, roles: [], canPropose: false, canApprove: false, canReject: false, uncertain: false };
  if (!account) return out;
  for (const role of policy.roles) {
    const m = matches(role, account, delegated);
    if (m === null) {
      out.uncertain = true;
      continue;
    }
    if (!m) continue;
    out.roles.push(role.name);
    if (role.kind !== "Everyone") out.member = true;
    out.canPropose ||= allows(role, "AddProposal");
    out.canApprove ||= allows(role, "VoteApprove");
    out.canReject ||= allows(role, "VoteReject");
  }
  return out;
}

export const policyUsesTokenRoles = (policy: DaoPolicy): boolean => policy.roles.some((r) => r.kind !== "Everyone" && "Member" in r.kind);

/** As `WeightOrRatio::to_weight`: a ratio needs strictly more than its share, capped at everyone. */
function toWeight(threshold: z.infer<typeof votePolicySchema>["threshold"], total: bigint): bigint {
  if (typeof threshold === "string") return BigInt(threshold) < total ? BigInt(threshold) : total;
  const w = (BigInt(threshold[0]) * total) / BigInt(threshold[1]) + 1n;
  return w < total ? w : total;
}

/**
 * How many approvals run a Budget proposal, for each named group that votes by head count. Token-weighted roles are
 * left out, because their threshold is a stake, not a count.
 */
export function approvalsNeeded(policy: DaoPolicy): Array<{ role: string; needed: number; of: number }> {
  const out: Array<{ role: string; needed: number; of: number }> = [];
  for (const role of policy.roles) {
    if (role.kind === "Everyone" || !("Group" in role.kind) || !allows(role, "VoteApprove")) continue;
    const vp = role.vote_policy[KIND_LABEL] ?? policy.default_vote_policy;
    if (vp.weight_kind !== "RoleWeight") continue;
    const total = BigInt(role.kind.Group.length);
    const byThreshold = toWeight(vp.threshold, total);
    const needed = BigInt(vp.quorum) > byThreshold ? BigInt(vp.quorum) : byThreshold;
    out.push({ role: role.name, needed: Number(needed), of: role.kind.Group.length });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Proposals

const actionCallSchema = z.object({ method_name: z.string(), args: z.string(), deposit: u128, gas: u128 });
const functionCallKindSchema = z.object({ FunctionCall: z.object({ receiver_id: z.string(), actions: z.array(actionCallSchema) }) });

const STATUSES = ["InProgress", "Approved", "Rejected", "Removed", "Expired", "Moved", "Failed"] as const;
export type SputnikStatus = (typeof STATUSES)[number];

export const daoProposalSchema = z.object({
  id: z.number().int().nonnegative(),
  proposer: z.string(),
  description: z.string(),
  kind: z.unknown(),
  status: z.enum(STATUSES),
  vote_counts: z.record(z.string(), z.array(u128)).default({}),
  votes: z.record(z.string(), z.enum(["Approve", "Reject", "Remove"])).default({}),
  submission_time: u128,
});
export type DaoProposal = z.infer<typeof daoProposalSchema>;

/** The newest proposals are read; a DAO with more says so on the panel. */
export const PROPOSAL_PAGE = 50;

/** The `get_proposals` arguments for the newest page, given `get_last_proposal_id` (which is the count). */
export function latestProposalsArgs(lastProposalId: number): { from_index: number; limit: number } {
  return { from_index: Math.max(0, lastProposalId - PROPOSAL_PAGE), limit: PROPOSAL_PAGE };
}

export type ProposalAction = "open" | "deposit" | "revoke" | "reclaim" | "move_credit";

export type ProposalMeaning =
  | { recognized: true; action: ProposalAction; text: string; kind: FunctionCallKind }
  /** A call to the hub or the token that is not one of the five expected ones, or is malformed. Never approvable here. */
  | { recognized: false; receiver: string; method: string | null; problems: string[]; kind: FunctionCallKind | null };

export type BudgetContext = { hub: AccountId; token: AccountId; network: Network; dao: AccountId; budgetId: Id32; symbol: string; decimals: number };

const isAtomic = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);

/** The Budget id an `open_budget` proposal would create, with the DAO as owner, or null when its terms are malformed. */
function openedBudgetId(args: unknown, c: BudgetContext): { id: Id32; cap: bigint } | null {
  const t = (args as { terms?: Record<string, unknown> } | null)?.terms;
  if (!t || !isId32(t.agent_pk) || !isAccountId(t.settler) || !isAtomic(t.cap) || !isAtomic(t.valid_until) || !isId32(t.policy_hash) || !isId32(t.salt)) return null;
  if (!Array.isArray(t.payees) || !t.payees.every(isAccountId)) return null;
  try {
    const terms: BudgetTerms = {
      owner: c.dao,
      agentPk: publicKeyToString(id32Bytes(t.agent_pk)),
      settler: t.settler,
      cap: BigInt(t.cap),
      validUntil: BigInt(t.valid_until),
      payees: t.payees as AccountId[],
      policyHash: t.policy_hash,
      salt: t.salt,
    };
    return { id: budgetIdOf(c.hub, c.network, terms), cap: terms.cap };
  } catch {
    return null;
  }
}

/**
 * Reads one proposal for one Budget. Returns null when the proposal has nothing to do with this hub and token, or is a
 * well-formed action on another Budget. A call to the hub or token that the add-on's audit does not pass, or whose
 * arguments are not the expected shape, comes back as unrecognized, to be reviewed on chain and never approved here.
 */
export function proposalMeaning(addon: DaoAddon, rawKind: unknown, c: BudgetContext): ProposalMeaning | null {
  const parsed = functionCallKindSchema.safeParse(rawKind);
  if (!parsed.success) return null; // Transfers, policy changes and the rest are the DAO's own business.
  const kind = parsed.data as FunctionCallKind;
  const receiver = kind.FunctionCall.receiver_id;
  if (receiver !== c.hub && receiver !== c.token) return null;
  const method = kind.FunctionCall.actions[0]?.method_name ?? null;
  const unrecognized = (problems: string[]): ProposalMeaning => ({ recognized: false, receiver, method, problems, kind });

  const problems = addon.auditBudgetProposal(kind, c.hub, c.token);
  if (problems.length > 0) return unrecognized(problems);
  const call = addon.decodeKind(kind).calls[0]!;
  const args = call.args as Record<string, unknown> | null;
  const money = (atomic: string) => `${formatMoney(atomic, c.decimals)} ${c.symbol}`;

  switch (call.method) {
    case "open_budget": {
      const opened = openedBudgetId(args, c);
      if (!opened) return unrecognized(["open_budget terms are not in the expected shape"]);
      if (opened.id !== c.budgetId) return null;
      return { recognized: true, action: "open", text: `Open this Budget with a cap of ${money(opened.cap.toString())}`, kind };
    }
    case "ft_transfer_call": {
      let target: unknown;
      try {
        target = (JSON.parse(String(args?.msg)) as { budget?: { budget_id?: unknown } }).budget?.budget_id;
      } catch {
        target = undefined;
      }
      if (!isId32(target) || !isAtomic(args?.amount)) return unrecognized(["ft_transfer_call arguments are not a Budget deposit"]);
      if (target !== c.budgetId) return null;
      return { recognized: true, action: "deposit", text: `Deposit ${money(args.amount)} into this Budget`, kind };
    }
    case "revoke_budget":
    case "reclaim": {
      if (!isId32(args?.budget_id)) return unrecognized([`${call.method} names no Budget`]);
      if (args.budget_id !== c.budgetId) return null;
      return call.method === "revoke_budget"
        ? { recognized: true, action: "revoke", text: "Revoke this Budget on NEAR", kind }
        : { recognized: true, action: "reclaim", text: "Reclaim this Budget's escrow to the DAO", kind };
    }
    case "fund_from_credit": {
      if (!isId32(args?.budget_id) || !isAtomic(args?.amount)) return unrecognized(["fund_from_credit arguments are not in the expected shape"]);
      if (args.budget_id !== c.budgetId) return null;
      return { recognized: true, action: "move_credit", text: `Move ${money(args.amount)} of the DAO's hub credit into this Budget`, kind };
    }
    default:
      return unrecognized([`unexpected method ${call.method}`]);
  }
}

export type ProposalState = "pending" | "voting_closed" | "approved" | "rejected" | "failed" | "expired" | "removed";

export type ProposalView = {
  id: number;
  proposer: string;
  description: string;
  state: ProposalState;
  meaning: ProposalMeaning;
  approvals: string[];
  rejections: string[];
  /** How the connected account voted, if it did. */
  myVote: "Approve" | "Reject" | "Remove" | null;
  submittedAtMs: number;
  /** When voting closes: submission plus the policy's proposal period. */
  closesAtMs: number;
};

const NS_PER_MS = 1_000_000n;

function stateOf(p: DaoProposal, closesAtMs: number, nowMs: number): ProposalState {
  switch (p.status) {
    case "InProgress":
      // The DAO only writes "Expired" when someone next touches the proposal; past the period, a vote cannot pass.
      return nowMs > closesAtMs ? "voting_closed" : "pending";
    case "Approved":
      return "approved";
    case "Rejected":
      return "rejected";
    case "Failed":
      return "failed";
    case "Expired":
      return "expired";
    case "Removed":
    case "Moved":
      return "removed";
  }
}

/** The proposals that concern one Budget: pending first, oldest first; then the decided ones, newest first. */
export function budgetProposals(addon: DaoAddon, proposals: readonly DaoProposal[], policy: DaoPolicy, c: BudgetContext, account: AccountId | null, nowMs: number): ProposalView[] {
  const out: ProposalView[] = [];
  for (const p of proposals) {
    const meaning = proposalMeaning(addon, p.kind, c);
    if (!meaning) continue;
    const submittedAtMs = Number(BigInt(p.submission_time) / NS_PER_MS);
    const closesAtMs = submittedAtMs + Number(BigInt(policy.proposal_period) / NS_PER_MS);
    const state = stateOf(p, closesAtMs, nowMs);
    if (state === "removed") continue; // Sputnik: "Interfaces shouldn't show removed proposals."
    const voters = Object.entries(p.votes);
    out.push({
      id: p.id,
      proposer: p.proposer,
      description: p.description,
      state,
      meaning,
      approvals: voters.filter(([, v]) => v === "Approve").map(([a]) => a),
      rejections: voters.filter(([, v]) => v === "Reject").map(([a]) => a),
      myVote: account ? (p.votes[account] ?? null) : null,
      submittedAtMs,
      closesAtMs,
    });
  }
  // Pending ones in the order they were proposed, because they are meant to be approved in that order (open, then
  // deposit); what is already decided follows, newest first.
  const open = (v: ProposalView) => (v.state === "pending" ? 0 : 1);
  return out.sort((a, b) => open(a) - open(b) || (a.state === "pending" ? a.id - b.id : b.id - a.id));
}

/** Whether Approve may be offered: only for a recognized call that is still open, by someone who may approve and has not voted. */
export function voteOptions(v: ProposalView, ability: DaoAbility): { approve: boolean; reject: boolean; why: string | null } {
  if (v.state !== "pending") return { approve: false, reject: false, why: null };
  if (v.myVote) return { approve: false, reject: false, why: `You voted to ${v.myVote.toLowerCase()} this proposal.` };
  const approve = v.meaning.recognized && ability.canApprove;
  const reject = ability.canReject;
  const why = v.meaning.recognized ? null : "Approve is not offered here, because this is not a call Payminto expects. Review it on chain before anyone approves it.";
  return { approve, reject, why };
}

// ---------------------------------------------------------------------------------------------------------------------
// Building proposals

/** A proposal kind as the transaction it will run, for the review screen. */
export function innerTx(addon: DaoAddon, kind: FunctionCallKind): WalletTx {
  const d = addon.decodeKind(kind);
  return {
    receiverId: d.receiver,
    actions: d.calls.map((c) => ({ type: "FunctionCall" as const, params: { methodName: c.method, args: (c.args ?? {}) as Record<string, unknown>, gas: c.gas.toString(), deposit: c.deposit.toString() } })),
  };
}

/** Sputnik's own panics, in the words of what happened and what to do next. Anything else is returned unchanged. */
export function daoFailureText(error: string): string {
  if (/ERR_PERMISSION_DENIED/.test(error)) return "The DAO refused: this account may not do that under the DAO's policy. Nothing changed. Ask a member who may, or connect a member account.";
  if (/ERR_MIN_BOND/.test(error)) return "The DAO refused: its proposal bond changed since this page read it. Nothing changed. Close this, and propose again with the current bond.";
  if (/ERR_ALREADY_VOTED/.test(error)) return "The DAO refused: this account has already voted on the proposal. Nothing changed.";
  if (/ERR_WRONG_KIND/.test(error)) return "The DAO refused: the proposal on chain is not the one this page showed. Nothing changed. Reload and read it again before voting.";
  if (/ERR_PROPOSAL_NOT_READY_FOR_VOTE/.test(error)) return "The DAO refused: the proposal is no longer open for voting. Nothing changed. Reload to see how it ended.";
  if (/ERR_NO_PROPOSAL/.test(error)) return "The DAO has no such proposal any more. Nothing changed. Reload to see the current list.";
  return error;
}

const YOCTO_PER_NEAR = 10n ** 24n;

/** A bond in NEAR, exact: "0.1 NEAR", "1 NEAR". */
export function bondText(yocto: string): string {
  const v = BigInt(yocto);
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return `${v / YOCTO_PER_NEAR}${frac ? `.${frac}` : ""} NEAR`;
}
