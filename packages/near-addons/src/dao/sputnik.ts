import {
  budgetIdOf,
  depositBudgetTx,
  fundFromCreditTx,
  isAccountId,
  openBudgetTx,
  reclaimTx,
  revokeBudgetTx,
  type AccountId,
  type BudgetTerms,
  type FunctionCallAction,
  type Id32,
  type Network,
  type WalletTx,
} from "@payminto/chain";
import type { ViewRpc } from "../rpc.ts";

/**
 * Sputnik DAO v2 proposal JSON, transcribed from near-daos/sputnik-dao-contract `sputnikdao2/src/proposals.rs`.
 * `ActionCall` is `#[serde(deny_unknown_fields)]` with `args: Base64VecU8`, `deposit: NearToken` and `gas: Gas`, which
 * serialize as a base64 string and two decimal strings. A live testnet proposal has exactly this shape.
 */
export type ActionCall = { method_name: string; args: string; deposit: string; gas: string };
export type FunctionCallKind = { FunctionCall: { receiver_id: AccountId; actions: ActionCall[] } };
export type ProposalInput = { description: string; kind: FunctionCallKind };
export type VoteAction = "VoteApprove" | "VoteReject" | "VoteRemove" | "Finalize";

const TGAS = 1_000_000_000_000n;
/**
 * The approving vote runs the proposal inside `act_proposal`, so the inner calls must fit in that transaction's gas
 * next to the DAO's own work. 250 Tgas of inner gas leaves 50 Tgas of the 300 Tgas vote for the DAO.
 */
export const MAX_INNER_GAS = 250n * TGAS;
export const VOTE_GAS = 300n * TGAS;
export const ADD_PROPOSAL_GAS = 50n * TGAS;

const toBase64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const fromBase64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

/** Converts a wallet transaction into a FunctionCall proposal kind. All actions go to the one receiver, in order. */
export function functionCallKind(tx: WalletTx): FunctionCallKind {
  if (!isAccountId(tx.receiverId)) throw new Error("receiver must be a NEAR account id");
  if (tx.actions.length === 0) throw new Error("a proposal needs at least one action");
  let gas = 0n;
  const actions = tx.actions.map((a: FunctionCallAction): ActionCall => {
    if (a.type !== "FunctionCall") throw new Error("only FunctionCall actions can be proposed");
    if (!/^(0|[1-9][0-9]*)$/.test(a.params.gas) || !/^(0|[1-9][0-9]*)$/.test(a.params.deposit)) throw new Error("gas and deposit must be decimal strings");
    gas += BigInt(a.params.gas);
    return { method_name: a.params.methodName, args: toBase64(JSON.stringify(a.params.args)), deposit: a.params.deposit, gas: a.params.gas };
  });
  if (gas > MAX_INNER_GAS) throw new Error(`inner gas ${gas} is above ${MAX_INNER_GAS}, so the approving vote could not run it`);
  return { FunctionCall: { receiver_id: tx.receiverId, actions } };
}

/** `add_proposal`. The attached deposit must equal the DAO's `proposal_bond` exactly, or the DAO panics with ERR_MIN_BOND. */
export function addProposalTx(dao: AccountId, proposal: ProposalInput, proposalBond: string): WalletTx {
  if (!isAccountId(dao)) throw new Error("dao must be a NEAR account id");
  if (!/^(0|[1-9][0-9]*)$/.test(proposalBond)) throw new Error("proposalBond must be a yoctoNEAR decimal string");
  return {
    receiverId: dao,
    actions: [{ type: "FunctionCall", params: { methodName: "add_proposal", args: { proposal }, gas: ADD_PROPOSAL_GAS.toString(), deposit: proposalBond } }],
  };
}

/**
 * `act_proposal`. Since sputnik-dao-contract PR #217 (2025-03) the DAO requires the proposal `kind` and refuses a vote
 * whose kind differs from the stored one (ERR_WRONG_KIND), so a member votes on exactly what they read. Older DAO code
 * ignores the extra field. The approving vote executes the proposal, so it carries 300 Tgas.
 */
export function voteTx(dao: AccountId, id: number, kind: FunctionCallKind, action: VoteAction = "VoteApprove", memo?: string): WalletTx {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error("proposal id must be a non-negative integer");
  const args: Record<string, unknown> = { id, action, proposal: kind };
  if (memo !== undefined) args.memo = memo;
  return { receiverId: dao, actions: [{ type: "FunctionCall", params: { methodName: "act_proposal", args, gas: VOTE_GAS.toString(), deposit: "0" } }] };
}

export type DaoContext = { dao: AccountId; hub: AccountId; network: Network; proposalBond: string };

const proposal = (description: string, tx: WalletTx): ProposalInput => ({ description, kind: functionCallKind(tx) });

/**
 * Proposal 1 of 2 to open a Budget owned by the DAO: `open_budget` on the hub, paid from the DAO's NEAR balance for
 * storage. The hub makes the predecessor the owner, so `terms.owner` must be the DAO, and the Budget id in the
 * description is what the hub will return.
 */
export function openBudgetProposal(ctx: DaoContext, terms: BudgetTerms, storageDeposit: string): { budgetId: Id32; tx: WalletTx; proposal: ProposalInput } {
  if (terms.owner !== ctx.dao) throw new Error("terms.owner must be the DAO, because the hub makes the caller the owner");
  const budgetId = budgetIdOf(ctx.hub, ctx.network, terms);
  const p = proposal(
    `Payminto: open Budget ${budgetId} on ${ctx.hub} for agent ${terms.agentPk}, cap ${terms.cap} atomic, settler ${terms.settler}, valid until ${new Date(Number(terms.validUntil)).toISOString()}`,
    openBudgetTx(ctx.hub, terms, storageDeposit),
  );
  return { budgetId, tx: addProposalTx(ctx.dao, p, ctx.proposalBond), proposal: p };
}

/**
 * Proposal 2 of 2: `ft_transfer_call` of the DAO's own tokens to the hub, which raises escrow only. The hub accepts it
 * only when the token sender, the DAO, owns the Budget; otherwise the tokens are returned.
 */
export function depositProposal(ctx: DaoContext, token: AccountId, budgetId: Id32, amount: bigint): { tx: WalletTx; proposal: ProposalInput } {
  const p = proposal(`Payminto: deposit ${amount} atomic of ${token} into Budget ${budgetId} on ${ctx.hub} (raises escrow, not cap)`, depositBudgetTx(token, ctx.hub, budgetId, amount));
  return { tx: addProposalTx(ctx.dao, p, ctx.proposalBond), proposal: p };
}

/** `revoke_budget`: starts the settlement grace period, after which `reclaim` returns the escrow to the DAO. */
export function revokeProposal(ctx: DaoContext, budgetId: Id32): { tx: WalletTx; proposal: ProposalInput } {
  const p = proposal(`Payminto: revoke Budget ${budgetId} on ${ctx.hub}`, revokeBudgetTx(ctx.hub, budgetId));
  return { tx: addProposalTx(ctx.dao, p, ctx.proposalBond), proposal: p };
}

/** `reclaim`: after the deadline, returns the remaining escrow to the DAO. */
export function reclaimProposal(ctx: DaoContext, budgetId: Id32): { tx: WalletTx; proposal: ProposalInput } {
  const p = proposal(`Payminto: reclaim the escrow of Budget ${budgetId} on ${ctx.hub}`, reclaimTx(ctx.hub, budgetId));
  return { tx: addProposalTx(ctx.dao, p, ctx.proposalBond), proposal: p };
}

/**
 * `fund_from_credit`: moves the DAO's earned hub credit into one of its Budgets. The hub requires exactly 1 yoctoNEAR,
 * which the DAO attaches from its own balance when the proposal runs, so a vote is the confirmation.
 */
export function fundFromCreditProposal(ctx: DaoContext, budgetId: Id32, amount: bigint): { tx: WalletTx; proposal: ProposalInput } {
  const tx = fundFromCreditTx(ctx.hub, budgetId, amount);
  if (tx.actions[0]?.params.deposit !== "1") throw new Error("fund_from_credit must attach exactly 1 yoctoNEAR");
  const p = proposal(`Payminto: move ${amount} atomic of the DAO's hub credit into Budget ${budgetId} on ${ctx.hub} (raises escrow, not cap)`, tx);
  return { tx: addProposalTx(ctx.dao, p, ctx.proposalBond), proposal: p };
}

export type DecodedCall = { method: string; args: unknown; deposit: bigint; gas: bigint };

/** Decodes a proposal kind as read from `get_proposal`, so a member can check every call before voting. */
export function decodeKind(kind: FunctionCallKind): { receiver: AccountId; calls: DecodedCall[] } {
  const fc = kind.FunctionCall;
  return {
    receiver: fc.receiver_id,
    calls: fc.actions.map((a) => ({ method: a.method_name, args: JSON.parse(fromBase64(a.args)) as unknown, deposit: BigInt(a.deposit), gas: BigInt(a.gas) })),
  };
}

/** Methods a Payminto DAO proposal may call, by receiver role, and the exact deposit each must carry. */
const EXPECTED: Record<string, { on: "hub" | "token"; deposit: "1" | "0" | "storage" }> = {
  open_budget: { on: "hub", deposit: "storage" },
  revoke_budget: { on: "hub", deposit: "0" },
  reclaim: { on: "hub", deposit: "0" },
  fund_from_credit: { on: "hub", deposit: "1" },
  ft_transfer_call: { on: "token", deposit: "1" },
};

/**
 * Checks that a proposal read from chain is a well-formed Payminto Budget action: the right receiver, a known method,
 * the exact deposit, and for deposits a transfer to this hub. Returns the problems found; empty means it passed.
 */
export function auditBudgetProposal(kind: FunctionCallKind, hub: AccountId, token: AccountId): string[] {
  const problems: string[] = [];
  let decoded: ReturnType<typeof decodeKind>;
  try {
    decoded = decodeKind(kind);
  } catch {
    return ["args are not base64 JSON"];
  }
  if (decoded.calls.length !== 1) problems.push(`expected one call, found ${decoded.calls.length}`);
  for (const c of decoded.calls) {
    const rule = EXPECTED[c.method];
    if (!rule) {
      problems.push(`unexpected method ${c.method}`);
      continue;
    }
    const want = rule.on === "hub" ? hub : token;
    if (decoded.receiver !== want) problems.push(`${c.method} goes to ${decoded.receiver}, expected ${want}`);
    if (rule.deposit !== "storage" && c.deposit !== BigInt(rule.deposit)) problems.push(`${c.method} attaches ${c.deposit} yoctoNEAR, expected ${rule.deposit}`);
    if (c.method === "ft_transfer_call") {
      const a = c.args as { receiver_id?: string; msg?: string };
      if (a.receiver_id !== hub) problems.push(`ft_transfer_call sends to ${a.receiver_id}, expected the hub ${hub}`);
      try {
        const msg = JSON.parse(a.msg ?? "") as { budget?: { budget_id?: string } };
        if (!msg.budget?.budget_id) problems.push("ft_transfer_call msg is not a Budget deposit");
      } catch {
        problems.push("ft_transfer_call msg is not JSON");
      }
    }
  }
  return problems;
}

/** Reads the DAO's `proposal_bond` read-only, the exact deposit `add_proposal` needs. */
export async function readProposalBond(rpc: ViewRpc, dao: AccountId): Promise<string> {
  const policy = await rpc.view<{ proposal_bond: string }>(dao, "get_policy", {});
  if (!/^(0|[1-9][0-9]*)$/.test(policy.proposal_bond)) throw new Error("get_policy returned no proposal_bond");
  return policy.proposal_bond;
}
