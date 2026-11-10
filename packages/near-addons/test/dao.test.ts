import { budgetIdOf, publicKeyToString, revokeBudgetTx, type BudgetTerms } from "@payminto/chain";
import { describe, expect, it } from "vitest";
import {
  addProposalTx,
  auditBudgetProposal,
  decodeKind,
  depositProposal,
  functionCallKind,
  fundFromCreditProposal,
  openBudgetProposal,
  readProposalBond,
  reclaimProposal,
  revokeProposal,
  voteTx,
  type DaoContext,
  type FunctionCallKind,
} from "../src/dao/sputnik.ts";
import { ViewRpc } from "../src/rpc.ts";
import { fakeFetch, fixture, rpcView } from "./helpers.ts";

const live = fixture<{ proposal: { kind: FunctionCallKind }; proposal_bond: string }>("sputnik/testnet-functioncall-proposal.live.json");

const DAO = "acme.sputnik-v2.testnet";
const HUB = "hub.payminto.testnet";
const TOKEN = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const BUDGET = "ab".repeat(32);
const ctx: DaoContext = { dao: DAO, hub: HUB, network: "near:testnet", proposalBond: live.proposal_bond };
const terms: BudgetTerms = {
  owner: DAO,
  agentPk: publicKeyToString(new Uint8Array(32).fill(1)),
  settler: "node.payminto.testnet",
  cap: 50_000_000n,
  validUntil: 1_800_000_000_000n,
  payees: [],
  policyHash: "00".repeat(32),
  salt: "01".repeat(32),
};

describe("Sputnik DAO v2 proposal shape", () => {
  it("matches a live testnet FunctionCall proposal: the same keys, base64 args, decimal-string deposit and gas", () => {
    const ours = functionCallKind(revokeBudgetTx(HUB, BUDGET));
    const theirs = live.proposal.kind;
    expect(Object.keys(ours.FunctionCall).sort()).toEqual(Object.keys(theirs.FunctionCall).sort());
    expect(Object.keys(ours.FunctionCall.actions[0]!).sort()).toEqual(Object.keys(theirs.FunctionCall.actions[0]!).sort());
    for (const a of [...ours.FunctionCall.actions, ...theirs.FunctionCall.actions]) {
      expect(a.args).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(a.deposit).toMatch(/^[0-9]+$/);
      expect(a.gas).toMatch(/^[0-9]+$/);
    }
    expect(() => decodeKind(theirs)).not.toThrow();
  });

  it("encodes revoke_budget exactly", () => {
    expect(functionCallKind(revokeBudgetTx(HUB, BUDGET))).toEqual({
      FunctionCall: {
        receiver_id: HUB,
        actions: [
          {
            method_name: "revoke_budget",
            args: "eyJidWRnZXRfaWQiOiJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiIn0=",
            deposit: "0",
            gas: "30000000000000",
          },
        ],
      },
    });
  });

  it("wraps a proposal in add_proposal with exactly the bond attached", () => {
    const kind = functionCallKind(revokeBudgetTx(HUB, BUDGET));
    expect(addProposalTx(DAO, { description: "d", kind }, "1000000000000000000000000")).toEqual({
      receiverId: DAO,
      actions: [{ type: "FunctionCall", params: { methodName: "add_proposal", args: { proposal: { description: "d", kind } }, gas: "50000000000000", deposit: "1000000000000000000000000" } }],
    });
    expect(() => addProposalTx(DAO, { description: "d", kind }, "1 NEAR")).toThrow();
  });

  it("votes with the proposal kind and 300 Tgas, since the approving vote executes it", () => {
    const kind = functionCallKind(revokeBudgetTx(HUB, BUDGET));
    expect(voteTx(DAO, 7, kind)).toEqual({
      receiverId: DAO,
      actions: [{ type: "FunctionCall", params: { methodName: "act_proposal", args: { id: 7, action: "VoteApprove", proposal: kind }, gas: "300000000000000", deposit: "0" } }],
    });
    expect(voteTx(DAO, 7, kind, "VoteReject", "no").actions[0]!.params.args).toEqual({ id: 7, action: "VoteReject", proposal: kind, memo: "no" });
    expect(() => voteTx(DAO, -1, kind)).toThrow();
  });

  it("refuses inner gas the approving vote could not carry", () => {
    const tx = revokeBudgetTx(HUB, BUDGET);
    tx.actions[0]!.params.gas = "260000000000000";
    expect(() => functionCallKind(tx)).toThrow(/inner gas/);
  });
});

describe("Payminto Budget proposals for a DAO owner", () => {
  it("opens a Budget owned by the DAO and names the Budget id the hub will return", () => {
    const r = openBudgetProposal(ctx, terms, "100000000000000000000000");
    expect(r.budgetId).toBe(budgetIdOf(HUB, "near:testnet", terms));
    expect(r.proposal.description).toContain(r.budgetId);
    const d = decodeKind(r.proposal.kind);
    expect(d.receiver).toBe(HUB);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({ method: "open_budget", deposit: 100000000000000000000000n });
    expect((d.calls[0]!.args as { terms: { cap: string; settler: string } }).terms).toMatchObject({ cap: "50000000", settler: "node.payminto.testnet" });
    expect(r.tx.actions[0]!.params.deposit).toBe(live.proposal_bond);
    expect(auditBudgetProposal(r.proposal.kind, HUB, TOKEN)).toEqual([]);
  });

  it("refuses terms whose owner is not the DAO", () => {
    expect(() => openBudgetProposal(ctx, { ...terms, owner: "alice.testnet" }, "1")).toThrow(/owner must be the DAO/);
  });

  it("deposits through ft_transfer_call on the token with 1 yoctoNEAR and a Budget msg", () => {
    const r = depositProposal(ctx, TOKEN, BUDGET, 25_000_000n);
    const d = decodeKind(r.proposal.kind);
    expect(d.receiver).toBe(TOKEN);
    expect(d.calls[0]).toEqual({
      method: "ft_transfer_call",
      args: { receiver_id: HUB, amount: "25000000", msg: JSON.stringify({ budget: { budget_id: BUDGET } }) },
      deposit: 1n,
      gas: 100_000_000_000_000n,
    });
    expect(auditBudgetProposal(r.proposal.kind, HUB, TOKEN)).toEqual([]);
  });

  it("funds from credit with exactly 1 yoctoNEAR", () => {
    const r = fundFromCreditProposal(ctx, BUDGET, 3_000_000n);
    const d = decodeKind(r.proposal.kind);
    expect(d.calls[0]).toEqual({ method: "fund_from_credit", args: { budget_id: BUDGET, amount: "3000000" }, deposit: 1n, gas: 30_000_000_000_000n });
    expect(auditBudgetProposal(r.proposal.kind, HUB, TOKEN)).toEqual([]);
  });

  it("revokes and reclaims with no deposit", () => {
    for (const r of [revokeProposal(ctx, BUDGET), reclaimProposal(ctx, BUDGET)]) {
      expect(decodeKind(r.proposal.kind).calls[0]!.deposit).toBe(0n);
      expect(auditBudgetProposal(r.proposal.kind, HUB, TOKEN)).toEqual([]);
    }
  });

  it("audit catches a tampered proposal before a member votes", () => {
    const wrongDeposit = structuredClone(fundFromCreditProposal(ctx, BUDGET, 1n).proposal.kind);
    wrongDeposit.FunctionCall.actions[0]!.deposit = "0";
    expect(auditBudgetProposal(wrongDeposit, HUB, TOKEN).join()).toMatch(/attaches 0 yoctoNEAR, expected 1/);

    const elsewhere = structuredClone(depositProposal(ctx, TOKEN, BUDGET, 5n).proposal.kind);
    elsewhere.FunctionCall.actions[0]!.args = Buffer.from(JSON.stringify({ receiver_id: "attacker.testnet", amount: "5", msg: "" })).toString("base64");
    expect(auditBudgetProposal(elsewhere, HUB, TOKEN).join()).toMatch(/expected the hub/);

    const otherReceiver = structuredClone(revokeProposal(ctx, BUDGET).proposal.kind);
    otherReceiver.FunctionCall.receiver_id = "other-hub.testnet";
    expect(auditBudgetProposal(otherReceiver, HUB, TOKEN).join()).toMatch(/expected hub\.payminto\.testnet/);

    expect(auditBudgetProposal(live.proposal.kind, HUB, TOKEN).join()).toMatch(/unexpected method set/);
  });

  it("reads the proposal bond read-only from get_policy", async () => {
    const { fetch, calls } = fakeFetch([{ method: "POST", url: "https://rpc.testnet.near.org", rpc: "get_policy", status: 200, body: rpcView({ proposal_bond: live.proposal_bond }) }]);
    expect(await readProposalBond(new ViewRpc("https://rpc.testnet.near.org", fetch), DAO)).toBe("1000000000000000000000000");
    expect(calls).toHaveLength(1);
  });
});
