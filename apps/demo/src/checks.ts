import { STORAGE_BYTE_COST } from "@payminto/protocol";
import type { Report } from "./scenario.ts";

export type Check = { name: string; ok: boolean; detail: string };

const has = (r: Report, rule: string, by?: "agent" | "node") => r.refusals.some((x) => x.rule === rule && (by === undefined || x.enforcedBy === by));

/** A simulated run must say so first; a sandbox run must say SANDBOX and never claim a public network. */
function labeled(r: Report): boolean {
  if (r.label.length === 0) return false;
  return r.simulated ? r.label.startsWith("SIMULATED") : r.label.startsWith("SANDBOX") && !/testnet|mainnet/i.test(r.label);
}

/** Every invariant the story must show. The CLI exits non-zero when any of them fails. */
export function checkReport(r: Report): Check[] {
  const c = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });
  const describedRefusals = r.refusals.every((x) => x.attemptedAmount !== null && /^\d+$/.test(x.attemptedAmount) && x.retry !== null);
  const netExposure = r.refusals.find((x) => x.rule === "NET_EXPOSURE");
  const f = r.fundFromCredit;
  const st = r.storage;
  const g = r.guards;
  const { unlisted: un, lookalike: lk, approval: ap } = r.payeeCheck;
  // On a real chain the hub account's growth is exactly what the settler and the Budgets' reserves paid for, and the
  // hub's own balance fell by no more than the reserve bytes its owners had prepaid.
  const fromReserves = st.fromReserves * STORAGE_BYTE_COST;
  const hubPaidNothing =
    st.hubBytesGrown === null || (st.hubOwnChange !== null && BigInt(st.hubBytesGrown) * STORAGE_BYTE_COST === st.charged + fromReserves && st.hubOwnChange + fromReserves >= 0n);
  const checks = [
    c("chain is labeled", labeled(r), r.label),
    c(
      "three owners and a DAO-style owner hold Budgets on the hub",
      r.owners.length === 4 && r.owners.some((o) => /\.sputnik-v2\./.test(o.account)) && r.owners.every((o) => o.ownerOnChain === o.account),
      r.owners.map((o) => o.account).join(", "),
    ),
    c("agents paid per call", r.paidCalls > 0, `${r.paidCalls} paid calls`),
    c("HOURLY_CAP fired at the node for the swarm's shared Budget", has(r, "HOURLY_CAP", "node") && r.swarm.paid === r.swarm.hourlyCapCalls, `${r.swarm.workers} workers paid ${r.swarm.paid} of ${r.swarm.hourlyCapCalls} allowed`),
    c("REPEAT_REQUEST fired for a looping agent", has(r, "REPEAT_REQUEST"), "same request paid 3 times, the 4th refused"),
    c("NET_EXPOSURE fired at the node before settlement", has(r, "NET_EXPOSURE", "node") && ["after_settlement", "fund"].includes(String(netExposure?.retry?.kind)), `retry ${netExposure?.retry?.kind ?? "none"}`),
    c(
      "PAYEE_NOT_ALLOWED fired for an unlisted payee the payee check has nothing against, in the wallet and at the node",
      has(r, "PAYEE_NOT_ALLOWED", "agent") && has(r, "PAYEE_NOT_ALLOWED", "node") && un.onChain?.exists === true && un.onChain.registeredWithToken && un.node?.verdict === "allow",
      `${un.payee}: ${un.onChain ? (un.onChain.exists ? "exists on chain" : "MISSING on chain") : "not read"}, node's check ${un.node?.verdict ?? "not read"}; refused by the Budget's own list`,
    ),
    c(
      "PAYEE_BLOCKED stopped a lookalike of an allowed payee: the wallet signed nothing, the node refused a guard-off runtime, and no position moved",
      lk.onChain?.exists === false &&
        lk.node?.verdict === "block" &&
        lk.node.signals.includes("lookalike_payee") &&
        lk.wallet?.rule === "PAYEE_BLOCKED" &&
        lk.wallet.enforcedBy === "agent" &&
        lk.wallet.signals.includes("lookalike_payee") &&
        lk.walletSigned === 0n &&
        lk.positionAfter === lk.positionBefore &&
        has(r, "PAYEE_BLOCKED", "node") &&
        lk.nodeRecord?.rule === "PAYEE_BLOCKED" &&
        lk.nodeRecord.signedByNode &&
        lk.nodePosition === 0n &&
        lk.settledOnChain === 0n,
      `${lk.payee} imitates ${lk.imitates}, ${lk.onChain?.exists === false ? "does not exist on chain" : "EXISTS on chain"}; node ${lk.node ? `${lk.node.verdict} (${lk.node.signals.join(", ")})` : "not read"}; wallet signed ${lk.walletSigned}, node position ${lk.nodePosition}, signed record ${lk.nodeRecord?.signedByNode ? "verifies" : "MISSING"}`,
    ),
    c(
      "PAYEE_NEEDS_APPROVAL held a warned payee until the owner approved it on the node, the same call was then paid, and it waited again once the approval was withdrawn",
      ap.onChain?.exists === true &&
        !ap.onChain.registeredWithToken &&
        ap.node?.verdict === "warn" &&
        ap.node.signals.includes("token_unregistered") &&
        r.payeeCheck.atRegistration.some((v) => v.payee === ap.payee && v.status === "warn") &&
        ap.first?.rule === "PAYEE_NEEDS_APPROVAL" &&
        ap.first.retry?.kind === "approval" &&
        ap.waitingAtNode !== null &&
        ap.positionWhileWaiting === ap.positionBefore &&
        ap.approvedAtNode?.decision === "approve" &&
        ap.paid?.bookedAtNode === true &&
        ap.paid.amount === ap.price &&
        ap.positionAfterPaid === ap.positionBefore + ap.price &&
        ap.withdrawn &&
        ap.again?.rule === "PAYEE_NEEDS_APPROVAL" &&
        ap.waitingAgain &&
        ap.positionAfterAgain === ap.positionAfterPaid,
      `${ap.payee}: node ${ap.node ? `${ap.node.verdict} (${ap.node.signals.join(", ")})` : "not read"}; position ${ap.positionBefore} -> ${ap.positionWhileWaiting} waiting -> ${ap.positionAfterPaid} approved -> ${ap.positionAfterAgain} withdrawn`,
    ),
    c("every refusal carries the attempted amount and a retry hint", r.refusals.length > 0 && describedRefusals, `${r.refusals.length} refusals`),
    c("a batch settled on the hub, and its transaction is final", r.settlement.batches > 0 && r.settlement.gross > 0n && r.settlement.txFinal, `${r.settlement.batches} batch(es), tx ${r.settlement.txHashes.map((h) => h.slice(0, 10)).join(", ") || "none"}`),
    c("tokens moved are less than gross cleared", r.settlement.net < r.settlement.gross, `gross ${r.settlement.gross}, moved ${r.settlement.net}`),
    c(
      "the batch's storage was charged to the owners' prepaid reserves and the settler's prepaid balance, not to the hub",
      st.prepaidBefore > 0n && st.charged > 0n && st.charged <= st.prepaidBefore && st.fromReserves > 0n && hubPaidNothing,
      `${st.fromReserves} bytes from the Budgets' reserves, ${st.charged} yoctoNEAR from ${st.settler}` + (st.hubBytesGrown === null ? "" : `; hub grew ${st.hubBytesGrown} bytes, own balance ${st.hubOwnChange! >= 0n ? "+" : ""}${st.hubOwnChange}`),
    ),
    c(
      "fund_from_credit moved earned credit into escrow, not cap",
      f !== null && f.amount > 0n && f.escrowRise === f.amount && f.creditFall === f.amount && f.capUnchanged,
      f ? `${f.owner}: escrow +${f.escrowRise}, credit -${f.creditFall}, cap ${f.capUnchanged ? "unchanged" : "CHANGED"}` : "no owner had earned credit",
    ),
    c("transfers are fewer than calls", r.payout.transfers > 0 && r.payout.transfers < r.paidCalls, `${r.payout.transfers} transfers, ${r.paidCalls} calls`),
    c(
      "the node's payout paid every creditor its credit, final on chain",
      // Everything the batch credited leaves the hub, except what an owner moved back into escrow.
      r.payout.txFinal && r.payout.balanceRisesMatchCredits && r.payout.creditLeft === 0n && r.payout.paidOut > 0n && r.payout.paidOut === r.settlement.net - (f?.amount ?? 0n),
      `${r.payout.paidOut} paid to ${r.payout.creditors.length} creditors`,
    ),
    c("a receipt is proven from the hub's Merkle root (SDK)", r.proofs.sdk, r.proofs.sdkReason ?? "verified"),
    c("a receipt is proven through MCP prove_receipt", r.proofs.mcp, r.proofs.mcpReason ?? "verified"),
    c("the node's receipt key is registered on the hub", st.receiptKeyOnHub, st.settler),
    c(
      "settle_own credited exactly what the node never settled, with the node's acceptance checked against the hub",
      r.settleOwn.claims > 0 && r.settleOwn.credited === r.settleOwn.expected && r.settleOwn.checkedAgainst === "hub" && r.settleOwn.unsettleable === 0,
      `${r.settleOwn.credited} of ${r.settleOwn.expected}, export checked against the ${r.settleOwn.checkedAgainst}`,
    ),
    c("a replayed settle_own is refused", r.settleOwn.replayRefused, "STALE_VOUCHER"),
    c(
      "an owner's self-signed voucher with no node acceptance is refused by settle_own",
      g.ownerToSelf === "PAYEE_IS_OWNER" && g.ownerToAccomplice === "ACCEPTANCE_KEY_UNKNOWN" && g.escrowUntouched,
      `to itself ${g.ownerToSelf}, to an accomplice ${g.ownerToAccomplice}, escrow ${g.escrowUntouched ? "untouched" : "CHANGED"}`,
    ),
    c(
      "a voucher signed by the agent key after the revoke cannot be settled",
      g.leakedKeyAlone === "ACCEPTANCE_KEY_UNKNOWN" && g.datedAfterRevoke === "ACCEPTANCE_TOO_LATE" && g.escrowUntouched,
      `alone ${g.leakedKeyAlone}, with the node's signature dated after the revoke ${g.datedAfterRevoke}`,
    ),
    c("the standalone verifier proves the receipt file and rejects a tampered copy", r.verifier.genuine && r.verifier.tamperedRejected, r.verifier.how),
    c("the hub is solvent: balance = escrow + credits + in flight", r.solvent, r.solvencyError ?? "holds"),
  ];
  if (r.hub) {
    checks.push(
      c("the hub is locked and runs the committed hub.wasm", r.hub.accessKeys === 0 && r.hub.codeHash === r.hub.expectedCodeHash, `${r.hub.accessKeys} access keys, code hash ${r.hub.codeHash}`),
    );
  }
  return checks;
}
