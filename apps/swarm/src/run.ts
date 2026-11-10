/**
 * One run: several rounds end to end, then settlement, payouts and receipt proofs. The agents talk to the coordinator,
 * the paywalls and the clearing node over HTTP; chain facts are read from the hub's read side.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { receiptFile, verifyReceipt, type ReceiptFile } from "@payminto/demo";
import { formatAmount, type AccountId, type ClearingReceipt, type Id32 } from "@payminto/protocol";
import { verifyReceiptOnchain } from "@payminto/sdk";
import type { RefusalSeen } from "./agents.ts";
import { dataHostOf, PROOF_FILE_KIND, storageSupplierOf, verifyRound, VOID_TEXT, type Delivery, type DeliveryStop, type RoundFile, type RoundResult } from "./rules.ts";
import { demandOf, roundIdOf, sellerPlan, STRATEGY_TEXT, type BuyerStrategy, type SellerStrategy } from "./scenario.ts";
import type { World } from "./world.ts";

/** A receipt proof as the run writes it: the demo's receipt file, plus what an offline check needs. */
export type SwarmProofFile = ReceiptFile & {
  swarm: {
    kind: typeof PROOF_FILE_KIND;
    chain: string;
    round: string;
    buyer: AccountId;
    seller: AccountId;
    /** The Budget's agent key, as the hub stores it. */
    agentPk: string;
    /** The Merkle root the hub stored for the batch during the run. */
    batchRoot: Id32;
  };
};

export type AgentView = {
  account: AccountId;
  /** "buyer-3": the plain label, with the full account next to it wherever it is shown. */
  label: string;
  role: "buyer" | "seller";
  strategy: BuyerStrategy | SellerStrategy;
  strategyText: string;
  dataHost: boolean;
  publicKey: string;
  budgetId: Id32;
  cap: string;
  escrow: string;
  payees: AccountId[];
};

export type AgentLedger = {
  account: AccountId;
  /** From the agents' own records: what its key paid and what its endpoints were paid. */
  paid: string;
  received: string;
  /** From the hub: the Budget's spent and escrow, the account's credit and token balance. */
  spentOnHub: string;
  escrowBefore: string;
  escrowAfter: string;
  creditAfter: string;
  /** Tokens that reached the account's wallet through payout. */
  paidOut: string;
  ownerOnHub: AccountId | null;
};

export type BatchView = { batchId: Id32; root: Id32; gross: string; net: string; txHash: string | null; txFinal: boolean; claims: number; calls: number };

export type ProofView = {
  round: string;
  roundNumber: number;
  buyer: AccountId;
  seller: AccountId;
  callId: Id32;
  amount: string;
  batchId: Id32;
  steps: number;
  verified: boolean;
  reason: string | null;
  tamperedRejected: boolean;
  /** File names inside the run's output directory. */
  file: string;
  tamperedFile: string;
  /** The exact command that re-checks the file. */
  command: string;
};

export type SwarmEvent =
  | { type: "run.started"; label: string; simulated: boolean; seed: number; rounds: number; parent: AccountId; hub: AccountId; token: AccountId; node: AccountId; reserveUnitPrice: string; storage: { every: number; price: string }; data: { every: number; price: string }; agents: AgentView[]; outDir: string }
  | { type: "round.opened"; round: string; roundNumber: number; reserveUnitPrice: string; dataHost: AccountId | null }
  | { type: "round.demand"; round: string; seq: number; buyer: AccountId; units: number }
  | { type: "round.pooled"; round: string; pooledUnits: number; buyers: number }
  | { type: "round.committed"; round: string; seq: number; seller: AccountId; commitment: Id32 }
  | { type: "round.revealed"; round: string; seq: number; seller: AccountId; unitPrice: string; capacity: number; late: boolean }
  | { type: "round.closed"; round: string; roundNumber: number; result: RoundResult; storageSupplier: AccountId | null; dataHost: AccountId | null }
  | { type: "unit.delivered"; round: string; buyer: AccountId; seller: AccountId; n: number; amount: string }
  | { type: "unit.stopped"; round: string; buyer: AccountId; seller: AccountId; stop: DeliveryStop }
  | { type: "input.bought"; round: string; seller: AccountId; input: "storage" | "data"; from: AccountId; amount: string }
  | { type: "round.delivered"; round: string; roundNumber: number; delivery: Delivery | null; file: string; verifyCommand: string; verified: boolean }
  | { type: "settled"; batches: BatchView[]; gross: string; net: string; calls: number }
  | { type: "paid.out"; transfers: Array<{ account: AccountId; amount: string }>; transactions: number }
  | { type: "proof"; proof: ProofView }
  | { type: "ledger"; agents: AgentLedger[] }
  | { type: "run.finished"; table: Array<{ measure: string; value: string }>; checks: Array<{ name: string; ok: boolean; detail: string }>; ok: boolean };

export type RoundReport = {
  round: string;
  roundNumber: number;
  file: RoundFile;
  path: string;
  verified: boolean;
  problems: string[];
  /** Per buyer, from the buyer's own verified receipts: independent of the seller's count. */
  buyerPaid: Array<{ buyer: AccountId; calls: number; amount: bigint }>;
  /** What the hub settled for (this buyer's Budget, the winner) is checked over all rounds, not per round. */
  proof: ProofView | null;
};

export type Report = {
  label: string;
  simulated: boolean;
  scenario: World["scenario"];
  parent: AccountId;
  agents: AgentView[];
  rounds: RoundReport[];
  paidCalls: { gpu: number; storage: number; data: number; total: number };
  refusals: RefusalSeen[];
  settlement: { batches: BatchView[]; gross: bigint; net: bigint; calls: number; skipped: string | null };
  payout: { transfers: Array<{ account: AccountId; amount: bigint }>; transactions: number; txFinal: boolean; creditLeft: bigint; waitingRegistration: AccountId[] };
  ledger: AgentLedger[];
  /** For every (Budget, Payee) pair: what the agents' receipts say against what the hub settled. */
  settledPairs: { pairs: number; mismatches: string[] };
  solvent: boolean;
  solvencyError: string | null;
  outDir: string;
};

export type Say = (line: string) => void;
export type RunOptions = {
  outDir: string;
  /** How the output directory is written in printed commands (a path relative to where the user ran the command). */
  outDirShown: string;
  say?: Say;
  emit?: (e: SwarmEvent) => void;
  /** Awaited after every event, so a person can follow a served run. */
  pace?: () => Promise<void>;
};

const usdc = (a: bigint | string) => `${formatAmount(a)} USDC`;
const short = (account: AccountId) => account.slice(0, account.indexOf("."));
const sum = (xs: Iterable<bigint>) => [...xs].reduce((a, b) => a + b, 0n);

/** Message windows on the coordinator's clock, in its milliseconds. */
const WINDOW = 1_000;
const STEP = 10;

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export function agentViews(w: World): AgentView[] {
  return [...w.buyers, ...w.sellers].map((a) => ({
    account: a.account,
    label: short(a.account),
    role: a.spec.role,
    strategy: a.spec.strategy,
    strategyText: STRATEGY_TEXT[a.spec.strategy],
    dataHost: a.spec.role === "buyer" && a.spec.dataHost,
    publicKey: a.spec.key.publicKey,
    budgetId: a.budget.budgetId,
    cap: a.budget.cap.toString(),
    escrow: a.budget.escrow.toString(),
    payees: a.budget.payees,
  }));
}

export async function runSwarm(w: World, o: RunOptions): Promise<Report> {
  const say = o.say ?? (() => {});
  const emit = async (e: SwarmEvent) => {
    o.emit?.(e);
    await o.pace?.();
  };
  const s = w.scenario;
  const chain = w.chain;
  const all = [...w.buyers, ...w.sellers];
  const byAccount = new Map(all.map((a) => [a.account, a]));
  const agents = agentViews(w);
  const report: Report = {
    label: w.hub.label,
    simulated: w.hub.kind === "fake",
    scenario: s,
    parent: w.parent,
    agents,
    rounds: [],
    paidCalls: { gpu: 0, storage: 0, data: 0, total: 0 },
    refusals: [],
    settlement: { batches: [], gross: 0n, net: 0n, calls: 0, skipped: null },
    payout: { transfers: [], transactions: 0, txFinal: false, creditLeft: 0n, waitingRegistration: [] },
    ledger: [],
    settledPairs: { pairs: 0, mismatches: [] },
    solvent: false,
    solvencyError: null,
    outDir: o.outDir,
  };

  say(`Chain: ${w.hub.label}. Hub ${chain.hub}, token ${chain.token}, node ${chain.operator}.`);
  say(`Seed ${s.seed}: ${s.buyers} buyers and ${s.sellers} sellers, each a sub-account of ${w.parent} with its own key and its own Budget on the hub.`);
  say(`Posted prices: reserve ${usdc(s.reserveUnitPrice)} per GPU-hour, storage block ${usdc(s.storage.price)} (one per ${s.storage.every} units), dataset shard ${usdc(s.data.price)} (one per ${s.data.every} units).`);
  say("");
  say("Agents (scripted strategies, no model calls):");
  for (const a of agents) {
    const role = a.dataHost ? "buyer, data host" : a.role;
    say(`  ${a.account.padEnd(26)} ${role.padEnd(17)} ${a.strategy.padEnd(13)} Budget cap ${usdc(a.cap).padStart(14)}, escrow ${usdc(a.escrow).padStart(14)}`);
  }
  await emit({
    type: "run.started",
    label: w.hub.label,
    simulated: report.simulated,
    seed: s.seed,
    rounds: s.rounds,
    parent: w.parent,
    hub: chain.hub,
    token: chain.token,
    node: chain.operator,
    reserveUnitPrice: s.reserveUnitPrice.toString(),
    storage: { every: s.storage.every, price: s.storage.price.toString() },
    data: { every: s.data.every, price: s.data.price.toString() },
    agents,
    outDir: o.outDirShown,
  });

  const escrowBefore = new Map<AccountId, bigint>();
  const balanceBefore = new Map<AccountId, bigint>();
  for (const a of all) {
    escrowBefore.set(a.account, (await chain.budget(a.budget.budgetId))?.escrow ?? 0n);
    balanceBefore.set(a.account, await chain.balanceOf(a.account));
  }

  // ---- the rounds ----
  for (let n = 1; n <= s.rounds; n++) {
    const round = roundIdOf(s.seed, n);
    const host = dataHostOf(w.roster, n);
    say("");
    say(`Round ${n} (${round}): reserve ${usdc(s.reserveUnitPrice)} per unit${host ? `, data host ${short(host)}` : ""}`);
    const params = await json<RoundFile["params"]>(
      await fetch(`${w.coordinatorUrl}/rounds`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${w.openerToken}` },
        body: JSON.stringify({
          round,
          roundNumber: n,
          reserveUnitPrice: s.reserveUnitPrice.toString(),
          storage: { every: s.storage.every, price: s.storage.price.toString() },
          data: { every: s.data.every, price: s.data.price.toString() },
          roster: w.roster,
          poolWindow: WINDOW,
          commitWindow: WINDOW,
          revealWindow: WINDOW,
        }),
      }),
      `opening ${round}`,
    );
    await emit({ type: "round.opened", round, roundNumber: n, reserveUnitPrice: params.reserveUnitPrice, dataHost: host });
    const tick = () => w.clock.set(w.clock.now() + STEP);
    let seq = 0;

    // Rule 4: pooling.
    let pooled = 0;
    for (const b of w.buyers) {
      tick();
      const units = demandOf(s, b.spec, n);
      await b.postDemand(w.coordinatorUrl, round, units, s.reserveUnitPrice);
      pooled += units;
      await emit({ type: "round.demand", round, seq: ++seq, buyer: b.account, units });
    }
    w.clock.set(params.poolDeadline);
    say(`  pool         ${w.buyers.length} buyers asked for ${pooled} units`);
    await emit({ type: "round.pooled", round, pooledUnits: pooled, buyers: w.buyers.length });

    // Rule 5: every seller commits before anyone reveals.
    const plans = new Map(w.sellers.map((x) => [x.account, sellerPlan(s, x.spec, round, n)]));
    say(`  commitments  ${w.sellers.length} sealed bids, each a SHA-256 of the bid and a salt`);
    for (const x of w.sellers) {
      tick();
      const commitment = await x.commit(w.coordinatorUrl, round, plans.get(x.account)!);
      say(`    ${short(x.account).padEnd(10)} ${commitment}`);
      await emit({ type: "round.committed", round, seq: ++seq, seller: x.account, commitment });
    }
    w.clock.set(params.commitDeadline);
    for (const late of [false, true]) {
      if (late) w.clock.set(params.revealDeadline);
      for (const x of w.sellers) {
        const plan = plans.get(x.account)!;
        if (!plan.reveal || plan.revealLate !== late) continue;
        tick();
        await x.reveal(w.coordinatorUrl, round, plan.reveal);
        await emit({ type: "round.revealed", round, seq: ++seq, seller: x.account, unitPrice: plan.reveal.unitPrice.toString(), capacity: plan.reveal.capacity, late });
      }
    }
    w.clock.set(Math.max(w.clock.now(), params.revealDeadline) + STEP);

    // Rules 6 to 9: the coordinator closes and publishes.
    const file = await json<RoundFile>(await fetch(`${w.coordinatorUrl}/rounds/${round}/close`, { method: "POST" }), `closing ${round}`);
    const r = file.result;
    say("  reveals");
    for (const b of r.bids) {
      const shown = b.unitPrice === null ? "not revealed".padEnd(28) : `${usdc(b.unitPrice)} x ${String(b.capacity).padStart(3)} units`.padEnd(28);
      say(`    ${short(b.seller).padEnd(10)} ${shown} ${b.status === "valid" ? "valid" : `VOID ${b.reason}: ${VOID_TEXT[b.reason!]}`}`);
    }
    const supplier = r.winner ? storageSupplierOf(w.roster, r.winner) : null;
    await emit({ type: "round.closed", round, roundNumber: n, result: r, storageSupplier: supplier, dataHost: host });

    let delivery: Delivery | null = null;
    if (r.status === "cleared" && r.winner && r.clearingPrice) {
      const price = BigInt(r.clearingPrice);
      const winner = byAccount.get(r.winner) as World["sellers"][number];
      const valid = r.bids.filter((b) => b.status === "valid").length;
      say(`  winner       ${short(r.winner)}, the lowest valid bid at ${usdc(r.winnerUnitPrice!)}`);
      say(`  price        ${usdc(price)} per unit for every buyer: ${valid > 1 ? "the second-lowest valid bid" : "the reserve, because only one bid was valid"}`);
      say(`  awarded      ${r.awardedUnits} of ${r.pooledUnits} units${r.awardedUnits < r.pooledUnits ? ` (the winner's capacity), split by the largest remainder rule` : ""}; the pool owes at most ${usdc(r.totalDue)}`);

      // Rule 10.1: the operator lists the winner's endpoint at exactly the clearing price.
      const pay = await w.listService({ name: `GPU hours, round ${n}, by ${short(r.winner)}`, payee: r.winner, price, resource: `${winner.url}/gpu/${round}/unit`, description: `One GPU-hour of round ${round} at the clearing price` });
      const hostAgent = host ? (byAccount.get(host) as World["buyers"][number]) : null;
      const supplierAgent = supplier ? (byAccount.get(supplier) as World["sellers"][number]) : null;
      const pending: SwarmEvent[] = [];
      winner.beginDelivery({
        round,
        pay,
        limit: Math.max(1, Math.floor((r.awardedUnits * plans.get(r.winner)!.servePercent) / 100)),
        storage: { from: supplier, url: supplierAgent ? `${supplierAgent.url}/storage/block` : null, every: s.storage.every },
        data: { from: host, url: hostAgent?.dataUrl ?? null, every: s.data.every },
        onInput: (input, from, amount) => pending.push({ type: "input.bought", round, seller: winner.account, input, from, amount: amount.toString() }),
      });

      // Rule 10.2: passes, in roster order. A buyer stops at its first unit that does not arrive.
      const stops = new Map<AccountId, DeliveryStop>();
      const got = new Map<AccountId, number>();
      const most = Math.max(0, ...r.allocations.map((a) => a.units));
      for (let k = 1; k <= most; k++) {
        for (const a of r.allocations) {
          if (a.units < k || stops.has(a.buyer)) continue;
          const buyer = byAccount.get(a.buyer) as World["buyers"][number];
          const out = await buyer.buyUnit(winner.url, round, k);
          if (out.kind === "delivered") {
            got.set(a.buyer, k);
            await emit({ type: "unit.delivered", round, buyer: a.buyer, seller: winner.account, n: k, amount: out.receipt.amount });
          } else {
            const stop = { atUnit: k, ...out.stop };
            stops.set(a.buyer, stop);
            await emit({ type: "unit.stopped", round, buyer: a.buyer, seller: winner.account, stop });
          }
          for (const e of pending.splice(0)) await emit(e);
        }
      }

      const job = winner.report(round);
      const buyerPaid = r.allocations.map((a) => ({ buyer: a.buyer, ...byAccount.get(a.buyer)!.paidTo(winner.account, "gpu", round) }));
      delivery = {
        seller: winner.account,
        unitPrice: price.toString(),
        buyers: r.allocations.filter((a) => a.units > 0).map((a) => ({ buyer: a.buyer, delivered: got.get(a.buyer) ?? 0, paid: buyerPaid.find((p) => p.buyer === a.buyer)!.amount.toString(), stopped: stops.get(a.buyer) ?? null })),
        deliveredUnits: job.delivered,
        sellerReceived: job.received.toString(),
        storage: { from: job.storage.from, count: job.storage.count, paid: job.storage.paid.toString() },
        data: { from: job.data.from, count: job.data.count, paid: job.data.paid.toString() },
        inputRefused: job.inputRefused,
      };

      say("  shares       buyer        asked  allocated  share            delivered  paid");
      for (const a of r.allocations) {
        const d = delivery.buyers.find((x) => x.buyer === a.buyer);
        say(`               ${short(a.buyer).padEnd(12)} ${String(a.demanded).padStart(5)}  ${String(a.units).padStart(9)}  ${usdc(a.share).padEnd(15)}  ${String(d?.delivered ?? 0).padStart(9)}  ${usdc(d?.paid ?? "0")}`);
      }
      say(`  delivery     ${job.delivered} of ${r.awardedUnits} units delivered, one paid Call each: ${short(winner.account)} was paid ${usdc(job.received)}`);
      const refused = [...stops].filter(([, st]) => st.cause === "refused");
      for (const [buyer, st] of refused) {
        say(`    REFUSED ${st.rule} by the ${st.enforcedBy === "agent" ? "buyer's own client" : "clearing node"}: ${short(buyer)} at unit ${st.atUnit}, attempted ${usdc(st.attemptedAmount ?? "0")}, ${st.remainingBudget === null ? "-" : usdc(st.remainingBudget)} left under the Budget's cap; no money moved`);
      }
      const unavailable = [...stops].filter(([, st]) => st.cause === "seller-unavailable");
      if (unavailable.length > 0) {
        say(`    STOPPED ${short(winner.account)} stopped serving after ${job.delivered} units (HTTP 503 before the paywall): ${unavailable.length} buyers went without their next unit and paid nothing for it`);
      }
      say(`  inputs       ${short(winner.account)} bought ${job.storage.count} storage blocks from ${job.storage.from ? short(job.storage.from) : "nobody"} (${usdc(job.storage.paid)}) and ${job.data.count} dataset shards from ${job.data.from ? short(job.data.from) : "nobody"} (${usdc(job.data.paid)})`);
      report.rounds.push({ round, roundNumber: n, file, path: "", verified: false, problems: [], buyerPaid, proof: null });
    } else {
      say(`  no winner    ${r.status === "no-demand" ? "no buyer asked for units" : "no valid bid"}: nothing is delivered and nothing is paid`);
      report.rounds.push({ round, roundNumber: n, file, path: "", verified: false, problems: [], buyerPaid: [], proof: null });
    }

    // Rule 14: the round file, re-checked by the same pure function `pnpm swarm verify` runs.
    const rr = report.rounds.at(-1)!;
    rr.file = { ...file, delivery };
    const name = `round-${n}.json`;
    rr.path = join(o.outDir, name);
    writeFileSync(rr.path, `${JSON.stringify(rr.file, null, 2)}\n`);
    const check = verifyRound(JSON.parse(JSON.stringify(rr.file)));
    rr.verified = check.ok;
    rr.problems = check.problems;
    const verifyCommand = `pnpm swarm verify ${join(o.outDirShown, name)}`;
    say(`  round file   ${join(o.outDirShown, name)} (${rr.file.messages.length} signed messages); verifyRound: ${check.ok ? "OK" : `FAILED: ${check.problems[0]}`}`);
    await emit({ type: "round.delivered", round, roundNumber: n, delivery, file: name, verifyCommand, verified: check.ok });
  }

  for (const a of all) {
    report.refusals.push(...a.refusals);
    for (const p of a.paid) report.paidCalls[p.item]++;
  }
  report.paidCalls.total = report.paidCalls.gpu + report.paidCalls.storage + report.paidCalls.data;

  // ---- settlement: the node nets and settles; nothing in the swarm moves tokens ----
  say("");
  say("Settlement: the clearing node nets what the owner accounts owe each other and settles on the hub.");
  const settled = await json<{ batchIds?: Id32[]; batches?: Array<{ id: Id32; txHash: string | null; claims: number; calls: number }>; skipped?: string }>(
    await fetch(`${w.nodeUrl}/v1/settlements`, { method: "POST", headers: { authorization: `Bearer ${w.adminToken}` } }),
    "POST /v1/settlements",
  );
  if (settled.skipped) {
    report.settlement.skipped = settled.skipped;
    say(`  nothing settled: ${settled.skipped}`);
  }
  for (const id of settled.batchIds ?? []) {
    const b = await chain.batch(id);
    if (!b) throw new Error(`the node reports batch ${id}, but the hub does not have it`);
    const summary = settled.batches?.find((x) => x.id === id);
    const txHash = summary?.txHash ?? null;
    const state = txHash ? await chain.txState(txHash) : null;
    report.settlement.batches.push({ batchId: id, root: b.root, gross: b.gross.toString(), net: b.net.toString(), txHash, txFinal: state?.status === "final", claims: summary?.claims ?? 0, calls: summary?.calls ?? 0 });
    report.settlement.gross += b.gross;
    report.settlement.net += b.net;
    report.settlement.calls += summary?.calls ?? 0;
  }
  const { gross, net } = report.settlement;
  if (report.settlement.batches.length > 0) {
    say(`  ${report.settlement.batches.length} settle_batch call(s) for ${report.settlement.calls} paid Calls, each with a Merkle root of its Calls stored on the hub.`);
    say(`  Gross cleared ${usdc(gross)}. Net moved from escrow to credit ${usdc(net)}. Offset between owners ${usdc(gross - net)}.`);
  }
  await emit({ type: "settled", batches: report.settlement.batches, gross: gross.toString(), net: net.toString(), calls: report.settlement.calls });

  // ---- payout: one token transfer per net creditor ----
  const creditBefore = new Map<AccountId, bigint>();
  const balanceMid = new Map<AccountId, bigint>();
  for (const a of all) {
    creditBefore.set(a.account, await chain.creditOf(a.account));
    balanceMid.set(a.account, await chain.balanceOf(a.account));
  }
  const paidOut = await json<{ payouts?: Array<{ txHash: string | null; items: Array<{ account: string }> }>; waitingRegistration?: AccountId[]; skipped?: string }>(
    await fetch(`${w.nodeUrl}/v1/payouts`, { method: "POST", headers: { authorization: `Bearer ${w.adminToken}` } }),
    "POST /v1/payouts",
  );
  report.payout.transactions = paidOut.payouts?.length ?? 0;
  report.payout.waitingRegistration = paidOut.waitingRegistration ?? [];
  report.payout.txFinal = report.payout.transactions > 0;
  for (const p of paidOut.payouts ?? []) {
    const state = p.txHash ? await chain.txState(p.txHash) : null;
    if (state?.status !== "final") report.payout.txFinal = false;
  }
  for (const a of all) {
    const rise = (await chain.balanceOf(a.account)) - balanceMid.get(a.account)!;
    if (rise > 0n) report.payout.transfers.push({ account: a.account, amount: rise });
    report.payout.creditLeft += await chain.creditOf(a.account);
  }
  say(`Payout: ${report.payout.transactions} payout call(s), ${report.payout.transfers.length} token transfers, one per net creditor, for ${report.paidCalls.total} paid Calls.`);
  for (const t of report.payout.transfers) say(`  ${t.account.padEnd(26)} received ${usdc(t.amount)}`);
  await emit({ type: "paid.out", transfers: report.payout.transfers.map((t) => ({ account: t.account, amount: t.amount.toString() })), transactions: report.payout.transactions });

  // ---- each agent's books against the hub ----
  for (const a of all) {
    const b = await chain.budget(a.budget.budgetId);
    const received = sum(all.flatMap((x) => x.paid.filter((p) => p.receipt.payee === a.account).map((p) => BigInt(p.receipt.amount))));
    report.ledger.push({
      account: a.account,
      paid: sum(a.paid.map((p) => BigInt(p.receipt.amount))).toString(),
      received: received.toString(),
      spentOnHub: (b?.spent ?? 0n).toString(),
      escrowBefore: escrowBefore.get(a.account)!.toString(),
      escrowAfter: (b?.escrow ?? 0n).toString(),
      creditAfter: (await chain.creditOf(a.account)).toString(),
      paidOut: ((await chain.balanceOf(a.account)) - balanceBefore.get(a.account)!).toString(),
      ownerOnHub: b?.owner ?? null,
    });
    // What the hub settled for each (Budget, Payee) pair must be what this agent's receipts add up to.
    const perPayee = new Map<AccountId, bigint>();
    for (const p of a.paid) perPayee.set(p.receipt.payee, (perPayee.get(p.receipt.payee) ?? 0n) + BigInt(p.receipt.amount));
    for (const [payee, amount] of perPayee) {
      report.settledPairs.pairs++;
      const onHub = await chain.settledOf(a.budget.budgetId, payee);
      if (onHub !== amount) report.settledPairs.mismatches.push(`${short(a.account)} to ${short(payee)}: receipts ${amount}, hub ${onHub}`);
    }
  }
  await emit({ type: "ledger", agents: report.ledger });

  // ---- one receipt per round, proven against the root the hub stores ----
  say("");
  say("Receipts: one paid Call of each round, proven against the Merkle root the hub stores.");
  for (const rr of report.rounds) {
    const d = rr.file.delivery;
    if (!d) continue;
    // The middle delivered Call of the round, so the sample is neither the first nor the last leaf.
    const calls = all.flatMap((a) => a.paid.filter((p) => p.item === "gpu" && p.round === rr.round).map((p) => ({ buyer: a, receipt: p.receipt })));
    const sample = calls[Math.floor(calls.length / 2)];
    if (!sample) continue;
    rr.proof = await prove(w, o, rr.round, rr.roundNumber, sample.buyer.account, d.seller, sample.buyer.spec.key.publicKey, sample.receipt);
    const p = rr.proof;
    // The length of the path depends on where the Call's id sorts in the batch, so it is not printed: stdout stays the same for a seed.
    say(`  round ${rr.roundNumber}: ${short(p.buyer)} paid ${short(p.seller)} ${usdc(p.amount)}; Merkle path to the hub's root: ${p.verified ? "PROVEN" : `NOT PROVEN (${p.reason})`}; a copy with the amount raised by one: ${p.tamperedRejected ? "REJECTED" : "ACCEPTED"}`);
    say(`           ${p.command}`);
    await emit({ type: "proof", proof: p });
  }
  say("  A proof shows the Call is in a settled batch and that the buyer's key signed it. It does not show that the GPU work was done.");

  try {
    await w.hub.solvency();
    report.solvent = true;
  } catch (err) {
    report.solvencyError = err instanceof Error ? err.message : String(err);
  }
  return report;
}

async function prove(w: World, o: RunOptions, round: string, roundNumber: number, buyer: AccountId, seller: AccountId, agentPk: string, receipt: ClearingReceipt): Promise<ProofView> {
  const chain = w.chain;
  const file = `round-${roundNumber}.receipt.json`;
  const tamperedFile = `round-${roundNumber}.receipt.tampered.json`;
  const base = { round, roundNumber, buyer, seller, callId: receipt.callId, amount: receipt.amount, file, tamperedFile, command: `pnpm swarm prove ${join(o.outDirShown, file)}` };
  const res = await fetch(`${w.nodeUrl}/v1/receipts/${receipt.callId}/proof`);
  const p = res.ok ? ((await res.json()) as { batchId: Id32 | null; proof: Id32[] }) : null;
  if (!p?.batchId) return { ...base, batchId: "", steps: 0, verified: false, reason: "the node has no settled batch for this Call", tamperedRejected: false };
  const batch = await chain.batch(p.batchId);
  const proofFile: SwarmProofFile = {
    ...receiptFile({ network: chain.network, hub: chain.hub, operator: chain.operator, rpcUrl: w.hub.rpcUrl, batchId: p.batchId, proof: p.proof, receipt }),
    swarm: { kind: PROOF_FILE_KIND, chain: w.hub.label, round, buyer, seller, agentPk, batchRoot: batch?.root ?? "" },
  };
  const tampered: SwarmProofFile = { ...proofFile, receipt: { ...proofFile.receipt, amount: (BigInt(receipt.amount) + 1n).toString() } };
  writeFileSync(join(o.outDir, file), `${JSON.stringify(proofFile, null, 2)}\n`);
  writeFileSync(join(o.outDir, tamperedFile), `${JSON.stringify(tampered, null, 2)}\n`);
  // Two independent checks against the hub: the SDK's, and the demo verifier's, which reads the agent key from the hub.
  const sdk = await verifyReceiptOnchain({ chain, operator: chain.operator, nodeKey: w.nodeKey, agentPk: agentPk as `ed25519:${string}`, receipt, batchId: p.batchId, proof: p.proof });
  const onHub = await verifyReceipt(chain, proofFile);
  const bad = await verifyReceipt(chain, tampered);
  const failed = onHub.lines.find((l) => l.ok === false);
  return { ...base, batchId: p.batchId, steps: p.proof.length, verified: sdk.verified && onHub.ok, reason: sdk.reason ?? failed?.what ?? null, tamperedRejected: !bad.ok };
}
