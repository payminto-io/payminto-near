import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { budgetIdOf, depositBudgetTx, keypairFromSeed, type BudgetTerms, type WalletTx } from "@payminto/protocol";
import {
  approvalsNeeded,
  bondText,
  budgetProposals,
  daoAbility,
  daoAccountError,
  daoFailureText,
  daoPolicySchema,
  daoProposalSchema,
  innerTx,
  isDaoAccount,
  latestProposalsArgs,
  proposalMeaning,
  voteOptions,
  type BudgetContext,
  type DaoAddon,
  type DaoPolicy,
  type DaoProposal,
} from "@/lib/dao";
import { DEMO_DAO, DEMO_DAO_COUNCIL, DEMO_OUTSIDER, MockDao, type SeedProposal } from "@/lib/mock/dao";
import type { MockTxOutcome } from "@/lib/mock/server";
import { abilityText } from "@/components/app/dao-proposals";

const HUB = "hub.payminto.testnet";
const TOKEN = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const NETWORK = "near:testnet" as const;
const DAO = "acme-treasury.sputnik-v2.testnet";
const [ALICE, BOB, CAROL] = ["alice.testnet", "bob.testnet", "carol.testnet"];
const DAY_NS = 86_400_000_000_000n;
const NOW = Date.UTC(2026, 10, 10, 12);

/**
 * The policy `default_policy(council)` builds in sputnik-dao-contract `sputnikdao2/src/policy.rs`, as `get_policy`
 * serializes it: everyone may add proposals, the council may also vote, and a vote passes with more than half.
 * Source-derived, not recorded. The bond is the one recorded from a live testnet DAO in the add-on's fixture.
 */
const live = JSON.parse(readFileSync(resolve(process.cwd(), "../../packages/near-addons/test/fixtures/sputnik/testnet-functioncall-proposal.live.json"), "utf8")) as { proposal: Record<string, unknown>; proposal_bond: string };
const POLICY: DaoPolicy = daoPolicySchema.parse({
  roles: [
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    { name: "council", kind: { Group: [ALICE, BOB, CAROL] }, permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: live.proposal_bond,
  proposal_period: (7n * DAY_NS).toString(),
  bounty_bond: "1000000000000000000000000",
  bounty_forgiveness_period: DAY_NS.toString(),
});

const terms: BudgetTerms = {
  owner: DAO,
  agentPk: keypairFromSeed(new Uint8Array(32).fill(3)).publicKey,
  settler: "node.payminto.testnet",
  cap: 50_000_000n,
  validUntil: BigInt(NOW + 30 * 86_400_000),
  payees: ["market-data.testnet"],
  policyHash: "11".repeat(32),
  salt: "22".repeat(32),
};
const BUDGET = budgetIdOf(HUB, NETWORK, terms);
const OTHER_BUDGET = "cd".repeat(32);
const C: BudgetContext = { hub: HUB, token: TOKEN, network: NETWORK, dao: DAO, budgetId: BUDGET, symbol: "USDC", decimals: 6 };

let dao: DaoAddon;
let ctx: Parameters<DaoAddon["revokeProposal"]>[0];
beforeAll(async () => {
  dao = (await import("@payminto/near-addons")).dao;
  ctx = { dao: DAO, hub: HUB, network: NETWORK, proposalBond: POLICY.proposal_bond };
});

const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const stored = (id: number, kind: unknown, over: Partial<DaoProposal> = {}): DaoProposal => daoProposalSchema.parse({ id, proposer: ALICE, description: "d", kind, status: "InProgress", vote_counts: {}, votes: {}, submission_time: ns(NOW - 3_600_000), ...over });

describe("which accounts are DAOs", () => {
  it("knows the Sputnik v2 factory of each network", () => {
    expect(isDaoAccount("acme-treasury.sputnik-v2.testnet", "near:testnet")).toBe(true);
    expect(isDaoAccount("acme.sputnik-dao.near", "near:mainnet")).toBe(true);
    expect(isDaoAccount("acme.sputnik-dao.near", "near:testnet")).toBe(false);
    expect(isDaoAccount("sputnik-v2.testnet", "near:testnet")).toBe(false);
    expect(isDaoAccount("a.b.sputnik-v2.testnet", "near:testnet")).toBe(false);
    expect(isDaoAccount("alice.testnet", "near:testnet")).toBe(false);
    expect(isDaoAccount("acme.sputnik-v2.testnet", "near:sandbox")).toBe(false);
  });
  it("says what is wrong with a typed DAO account", () => {
    expect(daoAccountError("", "near:testnet")).toContain("my-team.sputnik-v2.testnet");
    expect(daoAccountError("alice.testnet", "near:testnet")).toContain("named like");
    expect(daoAccountError("acme.sputnik-v2.testnet", "near:testnet")).toBeNull();
    expect(daoAccountError("acme.sputnik-v2.testnet", "near:sandbox")).toContain("no Sputnik DAO factory");
  });
});

describe("the policy: who may propose and vote", () => {
  it("follows Policy::can_execute_action for call proposals", () => {
    expect(daoAbility(POLICY, ALICE)).toMatchObject({ member: true, canPropose: true, canApprove: true, canReject: true, roles: ["all", "council"] });
    expect(daoAbility(POLICY, "mallory.testnet")).toMatchObject({ member: false, canPropose: true, canApprove: false, canReject: false });
    expect(daoAbility(POLICY, null)).toMatchObject({ canPropose: false, canApprove: false });
    const strict = { ...POLICY, roles: [{ ...POLICY.roles[1]!, permissions: ["call:AddProposal", "transfer:*"] }] };
    expect(daoAbility(strict, ALICE)).toMatchObject({ canPropose: true, canApprove: false });
    expect(daoAbility(strict, "mallory.testnet")).toMatchObject({ canPropose: false });
  });

  it("judges a token role only when the stake was read", () => {
    const token = { ...POLICY, roles: [{ name: "holders", kind: { Member: "100" }, permissions: ["*:*"], vote_policy: {} }] } as DaoPolicy;
    expect(daoAbility(token, ALICE)).toMatchObject({ canApprove: false, uncertain: true });
    expect(daoAbility(token, ALICE, 100n)).toMatchObject({ canApprove: true, uncertain: false });
    expect(daoAbility(token, ALICE, 99n)).toMatchObject({ canApprove: false, uncertain: false });
  });

  it("counts the approvals a group needs as the contract does: more than the ratio, capped at everyone", () => {
    expect(approvalsNeeded(POLICY)).toEqual([{ role: "council", needed: 2, of: 3 }]);
    const two = { ...POLICY, roles: [{ ...POLICY.roles[1]!, kind: { Group: [ALICE, BOB] } }] } as DaoPolicy;
    expect(approvalsNeeded(two)).toEqual([{ role: "council", needed: 2, of: 2 }]);
    const fixed = { ...POLICY, default_vote_policy: { weight_kind: "RoleWeight" as const, quorum: "0", threshold: "1" } };
    expect(approvalsNeeded(fixed)).toEqual([{ role: "council", needed: 1, of: 3 }]);
  });

  it("says the ability in one sentence", () => {
    expect(abilityText(null, null)).toContain("Connect a wallet");
    expect(abilityText(ALICE, daoAbility(POLICY, ALICE))).toBe("alice.testnet can propose and vote in this DAO.");
    expect(abilityText("mallory.testnet", daoAbility(POLICY, "mallory.testnet"))).toContain("can propose in this DAO, but cannot vote");
    const closed = { ...POLICY, roles: [POLICY.roles[1]!] };
    expect(abilityText("mallory.testnet", daoAbility(closed, "mallory.testnet"))).toContain("cannot propose or vote");
  });
});

describe("reading proposals", () => {
  it("parses a proposal recorded from a live testnet DAO, and asks for the newest page", () => {
    const p = daoProposalSchema.parse(live.proposal);
    expect(p).toMatchObject({ id: 4, status: "InProgress", proposer: "charleslavon.testnet" });
    expect(latestProposalsArgs(4)).toEqual({ from_index: 0, limit: 50 });
    expect(latestProposalsArgs(120)).toEqual({ from_index: 70, limit: 50 });
    // It calls a contract that is neither this hub nor the token, so it is none of this Budget's business.
    expect(proposalMeaning(dao, p.kind, C)).toBeNull();
  });

  it("decodes each Budget action built by the add-on into plain words", () => {
    const words = (kind: unknown) => {
      const m = proposalMeaning(dao, kind, C);
      return m && m.recognized ? m.text : m;
    };
    expect(words(dao.openBudgetProposal(ctx, terms, "100000000000000000000000").proposal.kind)).toBe("Open this Budget with a cap of 50.00 USDC");
    expect(words(dao.depositProposal(ctx, TOKEN, BUDGET, 25_000_000n).proposal.kind)).toBe("Deposit 25.00 USDC into this Budget");
    expect(words(dao.depositProposal(ctx, TOKEN, BUDGET, 1_234_567n).proposal.kind)).toBe("Deposit 1.234567 USDC into this Budget");
    expect(words(dao.revokeProposal(ctx, BUDGET).proposal.kind)).toBe("Revoke this Budget on NEAR");
    expect(words(dao.reclaimProposal(ctx, BUDGET).proposal.kind)).toBe("Reclaim this Budget's escrow to the DAO");
    expect(words(dao.fundFromCreditProposal(ctx, BUDGET, 1_250_000n).proposal.kind)).toBe("Move 1.25 USDC of the DAO's hub credit into this Budget");
  });

  it("leaves out well-formed actions on another Budget, and other kinds of proposal", () => {
    expect(proposalMeaning(dao, dao.revokeProposal(ctx, OTHER_BUDGET).proposal.kind, C)).toBeNull();
    expect(proposalMeaning(dao, dao.depositProposal(ctx, TOKEN, OTHER_BUDGET, 5n).proposal.kind, C)).toBeNull();
    expect(proposalMeaning(dao, dao.openBudgetProposal(ctx, { ...terms, salt: "33".repeat(32) }, "1").proposal.kind, C)).toBeNull();
    expect(proposalMeaning(dao, { Transfer: { token_id: "", receiver_id: ALICE, amount: "1" } }, C)).toBeNull();
    expect(proposalMeaning(dao, "Vote", C)).toBeNull();
  });

  it("marks any other call to the hub or the token as unrecognized, using the add-on's audit", () => {
    const call = (tx: WalletTx) => proposalMeaning(dao, dao.functionCallKind(tx), C);
    const fc = (receiverId: string, methodName: string, args: Record<string, unknown>, deposit = "0"): WalletTx => ({ receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas: "30000000000000", deposit } }] });
    expect(call(fc(TOKEN, "ft_transfer", { receiver_id: "mallory.testnet", amount: "40000000" }, "1"))).toMatchObject({ recognized: false, method: "ft_transfer", receiver: TOKEN });
    expect(call(fc(HUB, "set_settler", { account: "mallory.testnet", allowed: true }, "1"))).toMatchObject({ recognized: false, method: "set_settler" });
    // A deposit that sends the tokens somewhere other than this hub.
    const elsewhere = depositBudgetTx(TOKEN, "hub.someone-else.testnet", BUDGET, 5n);
    expect(call(elsewhere)).toMatchObject({ recognized: false });
    // revoke_budget with a deposit attached is not the call the add-on builds.
    expect(call(fc(HUB, "revoke_budget", { budget_id: BUDGET }, "1"))).toMatchObject({ recognized: false });
    expect(call(fc(HUB, "revoke_budget", { budget_id: "not-an-id" }))).toMatchObject({ recognized: false });
    // Args that are not base64 JSON.
    expect(proposalMeaning(dao, { FunctionCall: { receiver_id: HUB, actions: [{ method_name: "revoke_budget", args: "%%%", deposit: "0", gas: "1" }] } }, C)).toMatchObject({ recognized: false });
  });

  it("lists pending first, shows votes, and closes voting once the period has passed", () => {
    const deposit = dao.depositProposal(ctx, TOKEN, BUDGET, 25_000_000n).proposal.kind;
    const rows = [
      stored(0, dao.openBudgetProposal(ctx, terms, "1").proposal.kind, { status: "Approved", votes: { [ALICE]: "Approve", [BOB]: "Approve" }, submission_time: ns(NOW - 10 * 86_400_000) }),
      stored(1, deposit, { submission_time: ns(NOW - 8 * 86_400_000), votes: { [CAROL]: "Approve" } }),
      stored(2, dao.revokeProposal(ctx, OTHER_BUDGET).proposal.kind),
      stored(3, deposit, { votes: { [BOB]: "Approve" } }),
      stored(4, deposit, { status: "Removed" }),
      stored(5, dao.revokeProposal(ctx, BUDGET).proposal.kind),
    ];
    const views = budgetProposals(dao, rows, POLICY, C, ALICE, NOW);
    // Pending in the order proposed, so they are approved in that order; the decided ones after, newest first.
    expect(views.map((v) => [v.id, v.state])).toEqual([[3, "pending"], [5, "pending"], [1, "voting_closed"], [0, "approved"]]);
    expect(views[0]).toMatchObject({ approvals: [BOB], rejections: [], myVote: null });
    expect(views[3]!.approvals).toEqual([ALICE, BOB]);
    expect(budgetProposals(dao, rows, POLICY, C, BOB, NOW)[0]!.myVote).toBe("Approve");
  });
});

describe("what may be voted from the panel", () => {
  const view = (kind: unknown, over: Partial<DaoProposal> = {}, account = ALICE) => budgetProposals(dao, [stored(1, kind, over)], POLICY, C, account, NOW)[0]!;
  it("offers Approve only for a recognized call, to someone who may vote and has not", () => {
    const council = daoAbility(POLICY, ALICE);
    const good = dao.depositProposal(ctx, TOKEN, BUDGET, 5n).proposal.kind;
    expect(voteOptions(view(good), council)).toEqual({ approve: true, reject: true, why: null });
    expect(voteOptions(view(good), daoAbility(POLICY, "mallory.testnet"))).toMatchObject({ approve: false, reject: false });
    expect(voteOptions(view(good, { votes: { [ALICE]: "Approve" } }), council)).toMatchObject({ approve: false, reject: false });
    expect(voteOptions(view(good, { submission_time: ns(NOW - 8 * 86_400_000) }), council)).toEqual({ approve: false, reject: false, why: null });
    expect(voteOptions(view(good, { status: "Approved" }), council)).toMatchObject({ approve: false, reject: false });
  });
  it("never offers Approve for an unrecognized call, and says why", () => {
    const odd = dao.functionCallKind({ receiverId: TOKEN, actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: "mallory.testnet", amount: "1" }, gas: "30000000000000", deposit: "1" } }] });
    const o = voteOptions(view(odd), daoAbility(POLICY, ALICE));
    expect(o.approve).toBe(false);
    expect(o.reject).toBe(true);
    expect(o.why).toContain("not a call Payminto expects");
  });
});

describe("words", () => {
  it("writes a bond exactly", () => {
    expect(bondText("1000000000000000000000000")).toBe("1 NEAR");
    expect(bondText("100000000000000000000000")).toBe("0.1 NEAR");
    expect(bondText("1")).toBe("0.000000000000000000000001 NEAR");
  });
  it("turns Sputnik's panics into what happened and what to do", () => {
    expect(daoFailureText("Smart contract panicked: ERR_PERMISSION_DENIED")).toContain("may not do that under the DAO's policy");
    expect(daoFailureText("Smart contract panicked: ERR_MIN_BOND")).toContain("bond changed");
    expect(daoFailureText("Smart contract panicked: ERR_ALREADY_VOTED")).toContain("already voted");
    expect(daoFailureText("Smart contract panicked: ERR_WRONG_KIND")).toContain("not the one this page showed");
    expect(daoFailureText("something else")).toBe("something else");
  });
  it("shows a proposal's inner call as the transaction it will run", () => {
    const kind = dao.depositProposal(ctx, TOKEN, BUDGET, 25_000_000n).proposal.kind;
    expect(innerTx(dao, kind)).toEqual(depositBudgetTx(TOKEN, HUB, BUDGET, 25_000_000n));
  });
});

describe("the demo DAO keeps the contract's rules", () => {
  const [first, second] = DEMO_DAO_COUNCIL as [string, string, string];
  const setup = (seed: (a: DaoAddon) => SeedProposal[] = () => []) => {
    const ran: Array<{ tx: WalletTx; signer: string }> = [];
    let result: MockTxOutcome = { ok: true };
    const mock = new MockDao({ run: (tx, signer) => (ran.push({ tx, signer }), result), seed, addon: async () => dao });
    return { mock, ran, fail: () => (result = { ok: false, error: "Smart contract panicked: UNKNOWN_BUDGET" }) };
  };
  const demoCtx = () => ({ dao: DEMO_DAO, hub: HUB, network: NETWORK, proposalBond: "100000000000000000000000" });
  const proposals = async (mock: MockDao) => daoProposalSchema.array().parse(await mock.view("get_proposals", { from_index: 0, limit: 50 }));

  it("serves a policy the dashboard parses, and takes a proposal only with the exact bond from someone who may propose", async () => {
    const { mock } = setup();
    expect(daoPolicySchema.parse(await mock.view("get_policy", {})).proposal_bond).toBe("100000000000000000000000");
    const built = dao.revokeProposal(demoCtx(), BUDGET);
    expect(await mock.apply({ ...built.tx, receiverId: "someone-else.testnet" }, first)).toBeNull();
    expect(await mock.apply(dao.revokeProposal({ ...demoCtx(), proposalBond: "1" }, BUDGET).tx, first)).toMatchObject({ ok: false, error: expect.stringContaining("ERR_MIN_BOND") });
    expect(await mock.apply(built.tx, DEMO_OUTSIDER)).toMatchObject({ ok: false, error: expect.stringContaining("ERR_PERMISSION_DENIED") });
    expect(await mock.apply(built.tx, first)).toEqual({ ok: true });
    expect(await mock.view("get_last_proposal_id", {})).toBe(1);
    expect((await proposals(mock))[0]).toMatchObject({ id: 0, proposer: first, status: "InProgress" });
  });

  it("runs the call when approvals reach the threshold, as the DAO, and refuses a second vote, a wrong kind and an outsider", async () => {
    const { mock, ran } = setup();
    const built = dao.depositProposal(demoCtx(), TOKEN, BUDGET, 25_000_000n);
    await mock.apply(built.tx, first);
    const kind = built.proposal.kind;
    expect(await mock.apply(dao.voteTx(DEMO_DAO, 0, kind), DEMO_OUTSIDER)).toMatchObject({ ok: false, error: expect.stringContaining("ERR_PERMISSION_DENIED") });
    expect(await mock.apply(dao.voteTx(DEMO_DAO, 0, dao.revokeProposal(demoCtx(), BUDGET).proposal.kind), first)).toMatchObject({ ok: false, error: expect.stringContaining("ERR_WRONG_KIND") });
    expect(await mock.apply(dao.voteTx(DEMO_DAO, 7, kind), first)).toMatchObject({ ok: false, error: expect.stringContaining("ERR_NO_PROPOSAL") });
    expect(await mock.apply(dao.voteTx(DEMO_DAO, 0, kind), first)).toEqual({ ok: true });
    expect(ran).toEqual([]);
    expect(await mock.apply(dao.voteTx(DEMO_DAO, 0, kind), first)).toMatchObject({ ok: false, error: expect.stringContaining("ERR_ALREADY_VOTED") });
    expect(await mock.apply(dao.voteTx(DEMO_DAO, 0, kind), second)).toEqual({ ok: true });
    expect(ran).toEqual([{ tx: depositBudgetTx(TOKEN, HUB, BUDGET, 25_000_000n), signer: DEMO_DAO }]);
    expect((await proposals(mock))[0]).toMatchObject({ status: "Approved", votes: { [first]: "Approve", [second]: "Approve" } });
    expect(await mock.apply(dao.voteTx(DEMO_DAO, 0, kind, "VoteReject"), DEMO_DAO_COUNCIL[2]!)).toMatchObject({ ok: false, error: expect.stringContaining("ERR_PROPOSAL_NOT_READY_FOR_VOTE") });
  });

  it("marks a proposal failed when its call fails, rejected when enough reject, and expired after the period", async () => {
    const failing = setup();
    const built = dao.revokeProposal(demoCtx(), BUDGET);
    await failing.mock.apply(built.tx, first);
    failing.fail();
    await failing.mock.apply(dao.voteTx(DEMO_DAO, 0, built.proposal.kind), first);
    await failing.mock.apply(dao.voteTx(DEMO_DAO, 0, built.proposal.kind), second);
    expect((await proposals(failing.mock))[0]!.status).toBe("Failed");

    const rejecting = setup();
    await rejecting.mock.apply(built.tx, first);
    await rejecting.mock.apply(dao.voteTx(DEMO_DAO, 0, built.proposal.kind, "VoteReject"), first);
    await rejecting.mock.apply(dao.voteTx(DEMO_DAO, 0, built.proposal.kind, "VoteReject"), second);
    expect((await proposals(rejecting.mock))[0]!.status).toBe("Rejected");
    expect(rejecting.ran).toEqual([]);

    const old = setup((a) => [{ ...a.revokeProposal(demoCtx(), BUDGET).proposal, proposer: first, status: "InProgress", votes: {}, submittedMs: Date.now() - 8 * 86_400_000 }]);
    expect(await old.mock.apply(dao.voteTx(DEMO_DAO, 0, built.proposal.kind), first)).toEqual({ ok: true });
    expect((await proposals(old.mock))[0]).toMatchObject({ status: "Expired", votes: {} });
    expect(old.ran).toEqual([]);
  });
});
