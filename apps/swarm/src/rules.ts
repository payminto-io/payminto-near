/**
 * The rules of a round as pure functions, in the order RULES.md states them. Nothing here reads a clock, a file or the
 * network: the coordinator, the simulation and `pnpm swarm verify` all call the same code.
 */
import { z } from "zod";
import { compareAscii, isAccountId, isId32, isPublicKey, isSig64, sha256Text, signDigest, verifyDigest, type AccountId, type Id32, type PublicKey, type Sig64 } from "@payminto/protocol";

export const ROUND_FILE_KIND = "payminto.swarm.round.v1";
/** A receipt proof file written by a run: the demo's receipt file plus what an offline check needs. */
export const PROOF_FILE_KIND = "payminto.swarm.receipt-proof.v1";
export const BID_DOMAIN = "payminto.swarm.bid.v1";
export const MSG_DOMAIN = "payminto.swarm.msg.v1";
export const MAX_DEMAND_UNITS = 1_000;
export const MAX_CAPACITY = 1_000_000;

export const VOID_REASONS = ["NOT_REVEALED", "LATE_REVEAL", "COMMITMENT_MISMATCH", "ABOVE_RESERVE"] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

export const VOID_TEXT: Record<VoidReason, string> = {
  NOT_REVEALED: "the seller never revealed its bid",
  LATE_REVEAL: "the reveal arrived at or after the reveal deadline",
  COMMITMENT_MISMATCH: "the revealed bid does not hash to the commitment",
  ABOVE_RESERVE: "the unit price is above the reserve price",
};

// ---- the round file ----

const zAccount = z.string().refine(isAccountId, "must be a NEAR account id");
const zId32 = z.string().refine(isId32, "must be 64 lowercase hex characters");
const zSig = z.string().refine(isSig64, "must be 128 lowercase hex characters");
const zKey = z.string().refine(isPublicKey, "must be an ed25519 public key") as unknown as z.ZodType<PublicKey>;
/** Atomic token units as a decimal string, so a round file never loses precision. */
const zAtomic = z.string().regex(/^(0|[1-9][0-9]{0,29})$/, "must be a non-negative decimal integer with no leading zero");
const zPositiveAtomic = zAtomic.refine((v) => v !== "0", "must be positive");
const zTime = z.number().int().nonnegative();
export const zRoundId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase letters, digits and single hyphens").max(64);

const rosterEntrySchema = z.object({
  account: zAccount,
  role: z.enum(["buyer", "seller"]),
  publicKey: zKey,
  /** Rule I2: a buyer that also sells dataset shards. */
  dataHost: z.boolean().optional(),
});
export type RosterEntry = z.infer<typeof rosterEntrySchema>;

const inputRuleSchema = z.object({ every: z.number().int().min(1).max(1_000), price: zPositiveAtomic });

export const roundParamsSchema = z.object({
  round: zRoundId,
  /** 1 for the first round of a run. Rule I2 picks the data host from it. */
  roundNumber: z.number().int().min(1),
  reserveUnitPrice: zPositiveAtomic,
  openedAt: zTime,
  poolDeadline: zTime,
  commitDeadline: zTime,
  revealDeadline: zTime,
  storage: inputRuleSchema,
  data: inputRuleSchema,
  roster: z.array(rosterEntrySchema).min(1).max(400),
});
export type RoundParams = z.infer<typeof roundParamsSchema>;

const stamp = { seq: z.number().int().min(1), at: zTime, sig: zSig };
const demandSchema = z.object({ kind: z.literal("demand"), ...stamp, buyer: zAccount, units: z.number().int().min(1).max(MAX_DEMAND_UNITS), maxUnitPrice: zPositiveAtomic });
const commitSchema = z.object({ kind: z.literal("commit"), ...stamp, seller: zAccount, commitment: zId32 });
const revealSchema = z.object({ kind: z.literal("reveal"), ...stamp, seller: zAccount, unitPrice: zPositiveAtomic, capacity: z.number().int().min(1).max(MAX_CAPACITY), salt: zId32 });
export const messageSchema = z.discriminatedUnion("kind", [demandSchema, commitSchema, revealSchema]);
export type DemandMsg = z.infer<typeof demandSchema>;
export type CommitMsg = z.infer<typeof commitSchema>;
export type RevealMsg = z.infer<typeof revealSchema>;
export type RoundMessage = z.infer<typeof messageSchema>;

const bidOutcomeSchema = z.object({
  seller: zAccount,
  commitment: zId32,
  /** The commitment's sequence number: the tie-break. */
  seq: z.number().int().min(1),
  status: z.enum(["valid", "void"]),
  reason: z.enum(VOID_REASONS).nullable(),
  /** What the seller revealed, or null when it never did. Shown for a void bid too, so the reason can be checked. */
  unitPrice: zAtomic.nullable(),
  capacity: z.number().int().nullable(),
});
export type BidOutcome = z.infer<typeof bidOutcomeSchema>;

const allocationSchema = z.object({ buyer: zAccount, demanded: z.number().int(), units: z.number().int().min(0), share: zAtomic });
export type Allocation = z.infer<typeof allocationSchema>;

const outcomeShape = {
  status: z.enum(["cleared", "no-winner", "no-demand"]),
  /** Q: the sum of the pooled demands. */
  pooledUnits: z.number().int().min(0),
  bids: z.array(bidOutcomeSchema),
  winner: zAccount.nullable(),
  winnerUnitPrice: zAtomic.nullable(),
  /** P: what every unit of the round costs. */
  clearingPrice: zAtomic.nullable(),
  /** A = min(Q, the winner's capacity). */
  awardedUnits: z.number().int().min(0),
  allocations: z.array(allocationSchema),
  /** A * P: what the pool owes if every awarded unit is delivered. */
  totalDue: zAtomic,
};
const outcomeSchema = z.object(outcomeShape);
/** Everything the rules decide from the messages alone. */
export type RoundOutcome = z.infer<typeof outcomeSchema>;
export const roundResultSchema = z.object({ ...outcomeShape, closedAt: zTime });
export type RoundResult = z.infer<typeof roundResultSchema>;

const stopSchema = z.object({
  /** The unit (1-based) that did not arrive. */
  atUnit: z.number().int().min(1),
  cause: z.enum(["refused", "seller-unavailable", "unit-missing"]),
  /** For a refusal: the rule that fired, who enforced it, the attempted amount and what was left of the Budget. */
  rule: z.string().nullable(),
  enforcedBy: z.enum(["agent", "node"]).nullable(),
  attemptedAmount: zAtomic.nullable(),
  remainingBudget: zAtomic.nullable(),
});
export type DeliveryStop = z.infer<typeof stopSchema>;

const inputSchema = z.object({ from: zAccount.nullable(), count: z.number().int().min(0), paid: zAtomic });
export const deliverySchema = z.object({
  seller: zAccount,
  unitPrice: zAtomic,
  buyers: z.array(z.object({ buyer: zAccount, delivered: z.number().int().min(0), paid: zAtomic, stopped: stopSchema.nullable() })),
  /** Units the seller served, and what it was paid for them. */
  deliveredUnits: z.number().int().min(0),
  sellerReceived: zAtomic,
  storage: inputSchema,
  data: inputSchema,
  /** Set when an input purchase was refused and the seller stopped delivering (rule 12). */
  inputRefused: z.object({ input: z.enum(["storage", "data"]), rule: z.string() }).nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;

export const roundFileSchema = z.object({
  kind: z.literal(ROUND_FILE_KIND),
  params: roundParamsSchema,
  messages: z.array(messageSchema).max(2_000),
  result: roundResultSchema,
  delivery: deliverySchema.nullable().optional(),
});
export type RoundFile = z.infer<typeof roundFileSchema>;

// ---- rule 3: signed messages ----

/** The digest an agent signs: the domain, the kind, the round, the sender and the fields, joined by newlines. */
export function messageDigest(kind: RoundMessage["kind"], round: string, account: AccountId, fields: ReadonlyArray<string | number>): Id32 {
  return sha256Text([MSG_DOMAIN, kind, round, account, ...fields.map(String)].join("\n"));
}

export const demandFields = (m: Pick<DemandMsg, "units" | "maxUnitPrice">) => [m.units, m.maxUnitPrice];
export const commitFields = (m: Pick<CommitMsg, "commitment">) => [m.commitment];
export const revealFields = (m: Pick<RevealMsg, "unitPrice" | "capacity" | "salt">) => [m.unitPrice, m.capacity, m.salt];

export function signMessage(secretKey: Uint8Array, kind: RoundMessage["kind"], round: string, account: AccountId, fields: ReadonlyArray<string | number>): Sig64 {
  return signDigest(secretKey, messageDigest(kind, round, account, fields));
}

const senderOf = (m: RoundMessage): AccountId => (m.kind === "demand" ? m.buyer : m.seller);
const fieldsOf = (m: RoundMessage) => (m.kind === "demand" ? demandFields(m) : m.kind === "commit" ? commitFields(m) : revealFields(m));

/** True when the roster key of the sender signed exactly this message for this round. */
export function messageSigned(round: string, roster: readonly RosterEntry[], m: RoundMessage): boolean {
  const who = roster.find((r) => r.account === senderOf(m));
  return who !== undefined && verifyDigest(who.publicKey, messageDigest(m.kind, round, who.account, fieldsOf(m)), m.sig);
}

// ---- rule 5: the commitment ----

export type Bid = { unitPrice: bigint | string; capacity: number; salt: string };

/** sha256 of the six parts joined by newlines. Checkable with printf and shasum. */
export function commitmentOf(round: string, seller: AccountId, bid: Bid): Id32 {
  return sha256Text([BID_DOMAIN, round, seller, BigInt(bid.unitPrice).toString(), String(bid.capacity), bid.salt].join("\n"));
}

// ---- rule 3: phases ----

export type Phase = "pooling" | "commit" | "reveal" | "late" | "closed";
type Deadlines = Pick<RoundParams, "poolDeadline" | "commitDeadline" | "revealDeadline">;

export function phaseAt(p: Deadlines, t: number, closed = false): Phase {
  if (closed) return "closed";
  if (t < p.poolDeadline) return "pooling";
  if (t < p.commitDeadline) return "commit";
  if (t < p.revealDeadline) return "reveal";
  return "late";
}

// ---- rule 9: the largest remainder method ----

/**
 * Splits `total` whole items in proportion to the weights. Each party gets floor(total * w / W); the leftover items go
 * one each to the largest remainders, ties broken by key in ascending ASCII order. The sum is always `total`.
 */
export function apportion<K extends string>(parties: ReadonlyArray<{ key: K; weight: number }>, total: number): Map<K, number> {
  if (!Number.isInteger(total) || total < 0) throw new Error("total must be a non-negative integer");
  const out = new Map<K, number>();
  const W = parties.reduce((s, p) => s + BigInt(p.weight), 0n);
  if (W === 0n) {
    for (const p of parties) out.set(p.key, 0);
    return out;
  }
  const T = BigInt(total);
  let given = 0n;
  const rest: Array<{ key: K; remainder: bigint }> = [];
  for (const p of parties) {
    if (!Number.isInteger(p.weight) || p.weight < 0) throw new Error(`weight of ${p.key} must be a non-negative integer`);
    const product = T * BigInt(p.weight);
    const base = product / W;
    given += base;
    out.set(p.key, Number(base));
    rest.push({ key: p.key, remainder: product % W });
  }
  let left = T - given;
  rest.sort((a, b) => (a.remainder === b.remainder ? compareAscii(a.key, b.key) : a.remainder > b.remainder ? -1 : 1));
  for (const r of rest) {
    if (left === 0n) break;
    // A zero remainder means the party already holds its exact proportion.
    if (r.remainder === 0n) break;
    out.set(r.key, out.get(r.key)! + 1);
    left -= 1n;
  }
  if (left !== 0n) throw new Error("apportion: the weights exceed the total in a way the rule does not cover");
  return out;
}

/** Rule 9: who gets how many of the `awarded` units, and what each owes at price `P`. */
export function allocate(demands: ReadonlyArray<{ buyer: AccountId; units: number }>, awarded: number, price: bigint): Allocation[] {
  const pooled = demands.reduce((s, d) => s + d.units, 0);
  if (awarded > pooled) throw new Error("cannot award more units than the pool asked for");
  const units = apportion(demands.map((d) => ({ key: d.buyer, weight: d.units })), awarded);
  return demands.map((d) => ({ buyer: d.buyer, demanded: d.units, units: units.get(d.buyer)!, share: (BigInt(units.get(d.buyer)!) * price).toString() }));
}

// ---- rules 6 to 9: the outcome of a round ----

/**
 * Decides a round from its messages. Only the first demand of a buyer, the first commitment and the first reveal of a
 * seller count, which is also all a correct coordinator records.
 */
export function evaluateRound(params: Pick<RoundParams, "round" | "reserveUnitPrice" | "revealDeadline">, messages: readonly RoundMessage[]): RoundOutcome {
  const reserve = BigInt(params.reserveUnitPrice);
  const demands = new Map<AccountId, DemandMsg>();
  const commits = new Map<AccountId, CommitMsg>();
  const reveals = new Map<AccountId, RevealMsg>();
  for (const m of messages) {
    if (m.kind === "demand" && !demands.has(m.buyer)) demands.set(m.buyer, m);
    if (m.kind === "commit" && !commits.has(m.seller)) commits.set(m.seller, m);
    if (m.kind === "reveal" && !reveals.has(m.seller)) reveals.set(m.seller, m);
  }
  const pool = [...demands.values()].map((d) => ({ buyer: d.buyer, units: d.units }));
  const pooledUnits = pool.reduce((s, d) => s + d.units, 0);

  const bids: BidOutcome[] = [...commits.values()].map((c) => {
    const r = reveals.get(c.seller);
    const shown = { seller: c.seller, commitment: c.commitment, seq: c.seq, unitPrice: r?.unitPrice ?? null, capacity: r?.capacity ?? null };
    const reason: VoidReason | null = !r
      ? "NOT_REVEALED"
      : r.at >= params.revealDeadline
        ? "LATE_REVEAL"
        : commitmentOf(params.round, c.seller, r) !== c.commitment
          ? "COMMITMENT_MISMATCH"
          : BigInt(r.unitPrice) > reserve
            ? "ABOVE_RESERVE"
            : null;
    return { ...shown, status: reason ? "void" : "valid", reason };
  });

  const none = { winner: null, winnerUnitPrice: null, clearingPrice: null, awardedUnits: 0, totalDue: "0" };
  const unallocated = pool.map((d) => ({ buyer: d.buyer, demanded: d.units, units: 0, share: "0" }));
  if (pooledUnits === 0) return { status: "no-demand", pooledUnits, bids, ...none, allocations: unallocated };

  // Rule 7: lowest price, then the earliest commitment.
  const valid = bids
    .filter((b) => b.status === "valid")
    .sort((a, b) => {
      const pa = BigInt(a.unitPrice!);
      const pb = BigInt(b.unitPrice!);
      return pa === pb ? a.seq - b.seq : pa < pb ? -1 : 1;
    });
  const winner = valid[0];
  if (!winner) return { status: "no-winner", pooledUnits, bids, ...none, allocations: unallocated };

  // Rule 8: the lowest price among the other valid bids, or the reserve when there is none.
  const price = valid[1] ? BigInt(valid[1].unitPrice!) : reserve;
  const awardedUnits = Math.min(pooledUnits, winner.capacity!);
  return {
    status: "cleared",
    pooledUnits,
    bids,
    winner: winner.seller,
    winnerUnitPrice: winner.unitPrice,
    clearingPrice: price.toString(),
    awardedUnits,
    allocations: allocate(pool, awardedUnits, price),
    totalDue: (BigInt(awardedUnits) * price).toString(),
  };
}

// ---- rule 12: who supplies whom ----

/** The next seller on the roster, wrapping around; null with a single seller. */
export function storageSupplierOf(roster: readonly RosterEntry[], seller: AccountId): AccountId | null {
  const sellers = roster.filter((r) => r.role === "seller").map((r) => r.account);
  const i = sellers.indexOf(seller);
  if (i < 0 || sellers.length < 2) return null;
  return sellers[(i + 1) % sellers.length]!;
}

/** hosts[(roundNumber - 1) mod H], in roster order; null with no host. */
export function dataHostOf(roster: readonly RosterEntry[], roundNumber: number): AccountId | null {
  const hosts = roster.filter((r) => r.role === "buyer" && r.dataHost === true).map((r) => r.account);
  if (hosts.length === 0) return null;
  return hosts[(roundNumber - 1) % hosts.length]!;
}

// ---- rule 14: checking a published round ----

export type RoundCheck = { name: string; ok: boolean; detail: string };
export type VerifyRoundResult = { ok: boolean; checks: RoundCheck[]; problems: string[]; outcome: RoundOutcome | null };

/** Field by field, whatever order the keys were written in. */
const same = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? null) === (b[k] ?? null));
};

/**
 * Re-checks a published round from its messages alone, then the delivery record against rules 10 and 12. Pure: the same
 * input always gives the same answer. Accepts anything, so a file that is not a round fails with a reason, not a throw.
 */
export function verifyRound(input: unknown): VerifyRoundResult {
  const parsed = roundFileSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`);
    return { ok: false, checks: [{ name: "the file is a Payminto swarm round file", ok: false, detail: problems.join("; ") }], problems, outcome: null };
  }
  const file = parsed.data;
  const { params: p, messages, result } = file;
  const checks: RoundCheck[] = [];
  const problems: string[] = [];
  const check = (name: string, found: string[], okDetail: string) => {
    checks.push({ name, ok: found.length === 0, detail: found.length === 0 ? okDetail : found.slice(0, 4).join("; ") + (found.length > 4 ? `; and ${found.length - 4} more` : "") });
    problems.push(...found);
  };
  const usdc = (v: string | bigint) => `${v} atomic`;

  // Rule 3: parameters and roster.
  {
    const bad: string[] = [];
    if (!(p.openedAt < p.poolDeadline && p.poolDeadline < p.commitDeadline && p.commitDeadline < p.revealDeadline)) bad.push("the deadlines are not in order: openedAt < poolDeadline < commitDeadline < revealDeadline");
    const accounts = new Set(p.roster.map((r) => r.account));
    if (accounts.size !== p.roster.length) bad.push("an account appears twice on the roster");
    if (new Set(p.roster.map((r) => r.publicKey)).size !== p.roster.length) bad.push("two roster entries share one key");
    if (result.closedAt < p.revealDeadline) bad.push(`the round was closed at ${result.closedAt}, before the reveal deadline ${p.revealDeadline}`);
    check("the deadlines are in order and the roster has one key per account", bad, `${p.roster.length} agents, reserve ${usdc(p.reserveUnitPrice)} per unit`);
  }

  // Rule 3: sequence, phases and signatures.
  const roster = new Map(p.roster.map((r) => [r.account, r]));
  {
    const bad: string[] = [];
    const unsigned: string[] = [];
    const seen = { demand: new Set<string>(), commit: new Set<string>(), reveal: new Set<string>() };
    let lastAt = p.openedAt;
    let firstReveal = Infinity;
    let lastCommit = 0;
    messages.forEach((m, i) => {
      const who = m.kind === "demand" ? m.buyer : m.seller;
      const label = `message ${m.seq} (${m.kind} from ${who})`;
      if (m.seq !== i + 1) bad.push(`${label}: sequence numbers must be 1, 2, 3 ... in file order`);
      if (m.at < lastAt) bad.push(`${label}: its time ${m.at} is before the message ahead of it`);
      lastAt = Math.max(lastAt, m.at);
      if (m.at > result.closedAt) bad.push(`${label}: recorded after the close`);
      const entry = roster.get(who);
      if (!entry) bad.push(`${label}: the sender is not on the roster`);
      else if (entry.role !== (m.kind === "demand" ? "buyer" : "seller")) bad.push(`${label}: a ${entry.role} cannot send a ${m.kind}`);
      if (seen[m.kind].has(who)) bad.push(`${label}: a second ${m.kind} from the same account`);
      seen[m.kind].add(who);
      const phase = phaseAt(p, m.at);
      if (m.kind === "demand") {
        if (phase !== "pooling") bad.push(`${label}: accepted at ${m.at}, outside the pooling phase`);
        if (BigInt(m.maxUnitPrice) < BigInt(p.reserveUnitPrice)) bad.push(`${label}: its limit ${m.maxUnitPrice} is under the reserve, so it cannot be pooled`);
      }
      if (m.kind === "commit") {
        if (phase !== "commit") bad.push(`${label}: accepted at ${m.at}, outside the commit phase`);
        lastCommit = Math.max(lastCommit, m.seq);
      }
      if (m.kind === "reveal") {
        if (phase !== "reveal" && phase !== "late") bad.push(`${label}: accepted at ${m.at}, before the commit deadline`);
        if (!seen.commit.has(who)) bad.push(`${label}: a reveal without a commitment`);
        firstReveal = Math.min(firstReveal, m.seq);
      }
      if (!messageSigned(p.round, p.roster, m)) unsigned.push(`${label}: the signature does not verify against the roster key`);
    });
    if (lastCommit > firstReveal) bad.push("a commitment was recorded after a reveal");
    check("every message is in sequence and inside its phase, and every commitment precedes every reveal", bad, `${messages.length} messages`);
    check("every message is signed by the roster key of its sender", unsigned, `${messages.length} signatures verified`);
  }

  // Rules 5 and 6: commitments.
  const outcome = evaluateRound(p, messages);
  {
    const bad: string[] = [];
    for (const b of outcome.bids) {
      const published = result.bids.find((x) => x.seller === b.seller);
      if (!published) bad.push(`${b.seller}: its commitment is missing from the published result`);
      else if (published.status !== b.status || published.reason !== b.reason) {
        bad.push(`${b.seller}: published as ${published.status}${published.reason ? ` (${published.reason})` : ""}, the rules give ${b.status}${b.reason ? ` (${b.reason})` : ""}`);
      } else if (!same(published, b)) bad.push(`${b.seller}: the published bid differs from the recorded messages`);
    }
    if (result.bids.length !== outcome.bids.length) bad.push(`the result lists ${result.bids.length} bids, the messages hold ${outcome.bids.length} commitments`);
    const valid = outcome.bids.filter((b) => b.status === "valid").length;
    check("every commitment matches its reveal or is void for the stated reason", bad, `${valid} valid, ${outcome.bids.length - valid} void of ${outcome.bids.length}`);
  }

  // Rules 7 and 8: winner and price.
  {
    const bad: string[] = [];
    if (result.status !== outcome.status) bad.push(`published status ${result.status}, the rules give ${outcome.status}`);
    if (result.winner !== outcome.winner) bad.push(`published winner ${result.winner ?? "none"}, the rules give ${outcome.winner ?? "none"}`);
    if (result.winnerUnitPrice !== outcome.winnerUnitPrice) bad.push(`published winning bid ${result.winnerUnitPrice ?? "none"}, the rules give ${outcome.winnerUnitPrice ?? "none"}`);
    if (result.clearingPrice !== outcome.clearingPrice) bad.push(`published clearing price ${result.clearingPrice ?? "none"}, the rules give ${outcome.clearingPrice ?? "none"}`);
    check(
      "the winner is the lowest valid bid and the clearing price is the second-lowest valid price",
      bad,
      outcome.winner ? `${outcome.winner} bid ${usdc(outcome.winnerUnitPrice!)}, every unit costs ${usdc(outcome.clearingPrice!)}` : `no winner (${outcome.status})`,
    );
  }

  // Rule 9: allocation and shares.
  {
    const bad: string[] = [];
    if (result.pooledUnits !== outcome.pooledUnits) bad.push(`published pooled demand ${result.pooledUnits}, the demands sum to ${outcome.pooledUnits}`);
    if (result.awardedUnits !== outcome.awardedUnits) bad.push(`published awarded units ${result.awardedUnits}, the rules give ${outcome.awardedUnits}`);
    if (result.totalDue !== outcome.totalDue) bad.push(`published total ${result.totalDue}, the rules give ${outcome.totalDue}`);
    if (result.allocations.length !== outcome.allocations.length) bad.push(`the result allocates to ${result.allocations.length} buyers, the pool has ${outcome.allocations.length}`);
    for (const a of outcome.allocations) {
      const published = result.allocations.find((x) => x.buyer === a.buyer);
      if (!published) bad.push(`${a.buyer}: missing from the published allocation`);
      else if (!same(published, a)) bad.push(`${a.buyer}: published ${published.units} units and share ${published.share}, the rules give ${a.units} units and share ${a.share}`);
    }
    const price = BigInt(result.clearingPrice ?? "0");
    const shares = result.allocations.reduce((s, a) => s + BigInt(a.share), 0n);
    const units = result.allocations.reduce((s, a) => s + a.units, 0);
    if (units !== result.awardedUnits) bad.push(`the allocations sum to ${units} units, not the ${result.awardedUnits} awarded`);
    if (shares !== price * BigInt(result.awardedUnits)) bad.push(`the shares sum to ${shares}, not price times units ${price * BigInt(result.awardedUnits)}`);
    if (result.allocations.some((a) => a.units > a.demanded)) bad.push("a buyer was allocated more than it asked for");
    check("the units are split by the largest remainder rule and the shares sum to price times units", bad, `${outcome.awardedUnits} of ${outcome.pooledUnits} units awarded, total ${usdc(outcome.totalDue)}`);
  }

  // Rules 10 and 12: the delivery record.
  const d = file.delivery;
  if (d) {
    const bad: string[] = [];
    const price = BigInt(outcome.clearingPrice ?? "0");
    if (outcome.status !== "cleared") bad.push("a delivery is recorded for a round that did not clear");
    if (d.seller !== outcome.winner) bad.push(`delivery by ${d.seller}, but the winner is ${outcome.winner ?? "none"}`);
    if (BigInt(d.unitPrice) !== price) bad.push(`units were paid at ${d.unitPrice}, the clearing price is ${price}`);
    let units = 0;
    let paid = 0n;
    const listed = new Set<string>();
    for (const b of d.buyers) {
      const a = outcome.allocations.find((x) => x.buyer === b.buyer);
      if (listed.has(b.buyer)) bad.push(`${b.buyer}: listed twice in the delivery`);
      listed.add(b.buyer);
      if (!a) {
        bad.push(`${b.buyer}: received units without being in the pool`);
        continue;
      }
      if (b.delivered > a.units) bad.push(`${b.buyer}: received ${b.delivered} units, more than its ${a.units} allocated`);
      if (BigInt(b.paid) !== BigInt(b.delivered) * price) bad.push(`${b.buyer}: paid ${b.paid} for ${b.delivered} units at ${price}`);
      if (BigInt(b.paid) > BigInt(a.share)) bad.push(`${b.buyer}: paid ${b.paid}, more than its share ${a.share}`);
      if (b.delivered < a.units && !b.stopped) bad.push(`${b.buyer}: ${a.units - b.delivered} units are missing with no recorded cause`);
      if (b.stopped && b.stopped.atUnit !== b.delivered + 1) bad.push(`${b.buyer}: stopped at unit ${b.stopped.atUnit} after receiving ${b.delivered}`);
      units += b.delivered;
      paid += BigInt(b.paid);
    }
    for (const a of outcome.allocations) if (a.units > 0 && !listed.has(a.buyer)) bad.push(`${a.buyer}: allocated ${a.units} units but missing from the delivery`);
    if (d.deliveredUnits !== units) bad.push(`the seller counts ${d.deliveredUnits} delivered units, the buyers received ${units}`);
    if (BigInt(d.sellerReceived) !== paid) bad.push(`the seller received ${d.sellerReceived}, the buyers paid ${paid}`);
    if (BigInt(d.sellerReceived) !== BigInt(d.deliveredUnits) * price) bad.push(`the seller received ${d.sellerReceived} for ${d.deliveredUnits} units at ${price}`);
    check("no buyer paid more than its share, and the seller was paid exactly for the units it delivered", bad, `${units} units delivered, ${usdc(paid)} paid`);

    const inputs: string[] = [];
    const rule = (name: "storage" | "data", from: AccountId | null, every: number, unit: string) => {
      const got = d[name];
      if (got.from !== from) inputs.push(`${name}: bought from ${got.from ?? "nobody"}, the rule names ${from ?? "nobody"}`);
      const due = from ? Math.floor(d.deliveredUnits / every) : 0;
      const stoppedHere = d.inputRefused?.input === name;
      if (got.count > due || (got.count < due && !d.inputRefused) || (stoppedHere && got.count !== due - 1)) {
        inputs.push(`${name}: ${got.count} purchases for ${d.deliveredUnits} delivered units, the rule gives ${due}`);
      }
      if (BigInt(got.paid) !== BigInt(got.count) * BigInt(unit)) inputs.push(`${name}: paid ${got.paid} for ${got.count} purchases at ${unit}`);
    };
    rule("storage", outcome.winner ? storageSupplierOf(p.roster, outcome.winner) : null, p.storage.every, p.storage.price);
    rule("data", dataHostOf(p.roster, p.roundNumber), p.data.every, p.data.price);
    check("the seller's input purchases follow rules I1 and I2", inputs, `${d.storage.count} storage blocks from ${d.storage.from ?? "nobody"}, ${d.data.count} dataset shards from ${d.data.from ?? "nobody"}`);
  }

  return { ok: problems.length === 0, checks, problems, outcome };
}
