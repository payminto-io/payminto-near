/** The measured table and the invariants of a run. The CLI exits non-zero when any check fails. */
import { formatAmount } from "@payminto/protocol";
import { commitmentOf, verifyRound } from "./rules.ts";
import type { Report } from "./run.ts";

export type Check = { name: string; ok: boolean; detail: string };
export type TableRow = { measure: string; value: string };

const usdc = (a: bigint | string) => `${formatAmount(a)} USDC`;
const short = (account: string) => account.slice(0, account.indexOf("."));

/** Refusals grouped by the rule that fired and by who enforced it. */
export function refusalsByRule(r: Report): Array<{ rule: string; enforcedBy: "agent" | "node"; count: number }> {
  const counts = new Map<string, { rule: string; enforcedBy: "agent" | "node"; count: number }>();
  for (const x of r.refusals) {
    const key = `${x.rule}|${x.enforcedBy}`;
    const c = counts.get(key) ?? { rule: x.rule, enforcedBy: x.enforcedBy, count: 0 };
    c.count++;
    counts.set(key, c);
  }
  return [...counts.values()].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.enforcedBy < b.enforcedBy ? -1 : 1));
}

/** Counts and amounts only. Nothing here is an estimate, and nothing is about gas or fees. */
export function measuredTable(r: Report): TableRow[] {
  const s = r.scenario;
  const cleared = r.rounds.filter((x) => x.file.result.status === "cleared").length;
  const refusals = refusalsByRule(r);
  const { gross, net } = r.settlement;
  const settleTx = r.settlement.batches.length;
  const tx = settleTx + r.payout.transactions;
  const c = r.paidCalls;
  return [
    { measure: "agents", value: `${r.agents.length} (${s.buyers} buyers, ${s.sellers} sellers), each with its own sub-account, key and Budget` },
    { measure: "owners", value: `${new Set(r.ledger.map((l) => l.ownerOnHub)).size} Budget owner accounts on the hub, all sub-accounts of ${r.parent}` },
    { measure: "rounds", value: `${r.rounds.length} (${cleared} cleared)` },
    { measure: "paid calls", value: `${c.total} (${c.gpu} GPU units, ${c.storage} storage blocks, ${c.data} dataset shards)` },
    { measure: "refusals by rule", value: refusals.length === 0 ? "none" : refusals.map((x) => `${x.rule} ${x.count} (by the ${x.enforcedBy === "agent" ? "agent's own client" : "clearing node"})`).join(", ") },
    { measure: "gross amount cleared", value: usdc(gross) },
    { measure: "net amount moved", value: `${usdc(net)} (offset between owners: ${usdc(gross - net)})` },
    { measure: "token transfers at settlement", value: `${r.payout.transfers.length}, one per net creditor` },
    { measure: "transactions needed", value: `${tx} (${settleTx} settle_batch, ${r.payout.transactions} payout) against ${c.total} with one transaction per call` },
    { measure: "one-time setup", value: `${2 * r.agents.length} owner transactions before the first call: open_budget and an escrow deposit for each of the ${r.agents.length} Budgets` },
  ];
}

/** Every invariant of a run. Each one is computed from the round files, the agents' receipts and the hub's read side. */
export function checkRun(r: Report): Check[] {
  const c = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });
  const cleared = r.rounds.filter((x) => x.file.result.status === "cleared");

  const labeled = r.label.length > 0 && (r.simulated ? r.label.startsWith("SIMULATED") : r.label.startsWith("SANDBOX") && !/testnet|mainnet/i.test(r.label));

  // Every agent: a direct sub-account of the one parent, its own key, and the owner of its Budget on the hub.
  const suffix = `.${r.parent}`;
  const underParent = r.agents.every((a) => a.account.endsWith(suffix) && !a.account.slice(0, -suffix.length).includes("."));
  const ownKeys = new Set(r.agents.map((a) => a.publicKey)).size === r.agents.length;
  const ownBudgets = new Set(r.agents.map((a) => a.budgetId)).size === r.agents.length && r.ledger.every((l) => l.ownerOnHub === l.account);

  // Rule 5, straight from the round files, without verifyRound: each valid bid hashes to its commitment.
  let bids = 0;
  let voided = 0;
  const badBids: string[] = [];
  for (const x of r.rounds) {
    for (const b of x.file.result.bids) {
      bids++;
      if (b.status === "void") {
        voided++;
        if (!b.reason) badBids.push(`${x.round} ${short(b.seller)}: void without a reason`);
      } else {
        const reveal = x.file.messages.find((m) => m.kind === "reveal" && m.seller === b.seller);
        if (!reveal || reveal.kind !== "reveal" || commitmentOf(x.round, b.seller, reveal) !== b.commitment) badBids.push(`${x.round} ${short(b.seller)}: the reveal does not hash to the commitment`);
      }
    }
  }

  const unverified = r.rounds.filter((x) => !verifyRound(JSON.parse(JSON.stringify(x.file))).ok);

  const badSums: string[] = [];
  for (const x of cleared) {
    const res = x.file.result;
    const shares = res.allocations.reduce((s, a) => s + BigInt(a.share), 0n);
    const due = BigInt(res.clearingPrice!) * BigInt(res.awardedUnits);
    if (shares !== due) badSums.push(`${x.round}: shares ${shares}, price times units ${due}`);
  }

  // What each buyer paid is taken from its own verified receipts, not from the seller's count.
  const overpaid: string[] = [];
  const sellerMismatch: string[] = [];
  for (const x of cleared) {
    const res = x.file.result;
    const d = x.file.delivery;
    let fromReceipts = 0n;
    let calls = 0;
    for (const p of x.buyerPaid) {
      const share = BigInt(res.allocations.find((a) => a.buyer === p.buyer)?.share ?? "0");
      if (p.amount > share) overpaid.push(`${x.round} ${short(p.buyer)}: paid ${p.amount}, share ${share}`);
      fromReceipts += p.amount;
      calls += p.calls;
    }
    if (!d) {
      sellerMismatch.push(`${x.round}: no delivery record`);
      continue;
    }
    const due = BigInt(d.deliveredUnits) * BigInt(res.clearingPrice!);
    if (BigInt(d.sellerReceived) !== due || fromReceipts !== due || calls !== d.deliveredUnits) {
      sellerMismatch.push(`${x.round}: ${d.deliveredUnits} units at ${res.clearingPrice} is ${due}, the seller counts ${d.sellerReceived}, the buyers' receipts add up to ${fromReceipts} in ${calls} Calls`);
    }
  }

  // Every payee is a seller or data host of this run, funded and registered with the token before any Budget exists,
  // so a payee-check refusal means the run was set up wrong, not that the rules worked.
  const payeeHeld = r.refusals.filter((x) => x.rule === "PAYEE_BLOCKED" || x.rule === "PAYEE_NEEDS_APPROVAL");
  const describedRefusals = r.refusals.every((x) => x.attemptedAmount !== null && /^\d+$/.test(x.attemptedAmount) && x.retry !== null);
  const wantsRefusals = r.agents.some((a) => a.strategy === "capped" || a.strategy === "thin") && cleared.length > 0;

  // Each agent's books against the hub: a net debtor's escrow fell by its net debit, a net creditor was paid its net credit.
  const badBooks: string[] = [];
  let netCredits = 0n;
  for (const l of r.ledger) {
    const netPosition = BigInt(l.received) - BigInt(l.paid);
    const escrowFall = BigInt(l.escrowBefore) - BigInt(l.escrowAfter);
    const gained = BigInt(l.paidOut) + BigInt(l.creditAfter);
    const expectFall = netPosition < 0n ? -netPosition : 0n;
    const expectGain = netPosition > 0n ? netPosition : 0n;
    netCredits += expectGain;
    if (BigInt(l.spentOnHub) !== BigInt(l.paid)) badBooks.push(`${short(l.account)}: paid ${l.paid}, the hub counts ${l.spentOnHub} spent`);
    else if (escrowFall !== expectFall || gained !== expectGain) badBooks.push(`${short(l.account)}: net ${netPosition}, escrow fell ${escrowFall}, received ${gained}`);
  }
  // Netting happens inside one batch, so with several batches the hub can move more than the overall net.
  const oneBatch = r.settlement.batches.length === 1;
  if (!oneBatch) badBooks.length = 0;

  const { gross, net } = r.settlement;
  const paidOut = r.payout.transfers.reduce((s, t) => s + t.amount, 0n);
  const proofs = r.rounds.map((x) => x.proof).filter((p) => p !== null);
  const provenAll = proofs.length === cleared.filter((x) => (x.file.delivery?.deliveredUnits ?? 0) > 0).length && proofs.every((p) => p.verified && p.tamperedRejected);
  const totalPaid = r.ledger.reduce((s, l) => s + BigInt(l.paid), 0n);
  // Offsetting needs an account that both earned and spent. Rule 12 creates them unless there is one seller and no data host.
  const twoSided = r.ledger.some((l) => BigInt(l.paid) > 0n && BigInt(l.received) > 0n);

  return [
    c("chain is labeled", labeled, r.label),
    c("every agent is a direct sub-account of one parent, with its own key, and owns its own Budget on the hub", underParent && ownKeys && ownBudgets, `${r.agents.length} agents under ${r.parent}`),
    c("every commitment matches its reveal or is void with a reason", bids > 0 && badBids.length === 0, badBids[0] ?? `${bids - voided} valid, ${voided} void of ${bids} commitments in ${r.rounds.length} rounds`),
    c("the winner and the clearing price of every round match verifyRound", r.rounds.length > 0 && unverified.length === 0, unverified.length ? `failed: ${unverified.map((x) => x.round).join(", ")}` : `${r.rounds.length} round files re-checked from their signed messages`),
    c("the shares of every round sum exactly to the price times the units", badSums.length === 0, badSums[0] ?? `${cleared.length} cleared rounds`),
    c("no buyer paid more than its share", overpaid.length === 0, overpaid[0] ?? "from each buyer's own receipts"),
    c("every seller was paid exactly for the units it delivered", cleared.length > 0 && sellerMismatch.length === 0, sellerMismatch[0] ?? `${r.paidCalls.gpu} units, by the seller's count and by the buyers' receipts`),
    c(
      "no payee was held or blocked: every payee is one of the swarm's own registered agents",
      payeeHeld.length === 0,
      payeeHeld.length ? `${payeeHeld.length} refused by ${[...new Set(payeeHeld.map((x) => x.rule))].join(", ")}, first ${payeeHeld[0]!.agent}` : "the payee check had nothing against any seller or data host",
    ),
    c("every refusal names its rule, the attempted amount and a retry hint", describedRefusals && (!wantsRefusals || r.refusals.length > 0), `${r.refusals.length} refusals, no money moved for any of them`),
    c("a batch settled on the hub, and its transaction is final", r.settlement.batches.length > 0 && r.settlement.batches.every((b) => b.txFinal), r.settlement.skipped ?? `${r.settlement.batches.length} batch(es) for ${r.settlement.calls} Calls`),
    c("gross cleared on the hub equals what the agents' receipts add up to", gross === totalPaid && r.settlement.calls === r.paidCalls.total, `hub ${gross} in ${r.settlement.calls} Calls, receipts ${totalPaid} in ${r.paidCalls.total} Calls`),
    c("the hub settled every (Budget, Payee) pair for exactly what the receipts say", r.settledPairs.pairs > 0 && r.settledPairs.mismatches.length === 0, r.settledPairs.mismatches[0] ?? `${r.settledPairs.pairs} pairs`),
    twoSided
      ? c("net moved is less than gross cleared", net < gross, `gross ${usdc(gross)}, net ${usdc(net)}`)
      : c("net moved equals gross cleared, because no account both earned and spent", net === gross, `gross ${usdc(gross)}, net ${usdc(net)}: with one seller and no data host the rules create nothing to offset`),
    c(
      "each agent's escrow fell by its net debit, or it was paid its net credit, and nothing else",
      badBooks.length === 0 && (!oneBatch || net === netCredits),
      badBooks[0] ?? (oneBatch ? `${r.ledger.length} accounts, net credits ${usdc(netCredits)}` : `${r.settlement.batches.length} batches: offsets apply inside each batch, so this is checked per pair above`),
    ),
    c("payouts paid every net creditor, in fewer transfers than Calls", r.payout.txFinal && paidOut === net && r.payout.creditLeft === 0n && r.payout.transfers.length < r.paidCalls.total, `${usdc(paidOut)} in ${r.payout.transfers.length} transfers for ${r.paidCalls.total} Calls`),
    c("the hub is solvent: balance = escrow + credits + in flight", r.solvent, r.solvencyError ?? "holds"),
    c("one receipt per round is proven against the hub's Merkle root, and a tampered copy is rejected", proofs.length > 0 && provenAll, proofs.find((p) => !p.verified)?.reason ?? `${proofs.length} receipts`),
  ];
}
