import { keypairFromSeed, type AccountId, type Keypair } from "@payminto/protocol";
import { Coordinator, ManualClock } from "../src/coordinator.ts";
import { commitFields, commitmentOf, demandFields, revealFields, signMessage, type RosterEntry, type RoundFile } from "../src/rules.ts";

export const PARENT = "swarm.testnet";
export const RESERVE = 700_000n;

/** A fixed key per account, so test rounds are the same on every run. */
export function keyOf(account: AccountId): Keypair {
  const seed = new Uint8Array(32);
  new TextEncoder().encodeInto(account, seed);
  return keypairFromSeed(seed);
}

export const buyer = (n: number): AccountId => `buyer-${n}.${PARENT}`;
export const seller = (n: number): AccountId => `seller-${n}.${PARENT}`;
export const salt = (n: number): string => n.toString(16).padStart(64, "0");

export function rosterOf(buyers: number, sellers: number, hosts = 1): RosterEntry[] {
  return [
    ...Array.from({ length: buyers }, (_, i) => ({ account: buyer(i + 1), role: "buyer" as const, publicKey: keyOf(buyer(i + 1)).publicKey, ...(i < hosts ? { dataHost: true } : {}) })),
    ...Array.from({ length: sellers }, (_, i) => ({ account: seller(i + 1), role: "seller" as const, publicKey: keyOf(seller(i + 1)).publicKey })),
  ];
}

export type BidPlan = {
  seller: number;
  unitPrice: bigint;
  capacity: number;
  /** "late": after the reveal deadline. "never": no reveal. "other": reveals a price it did not commit to. */
  reveal?: "on-time" | "late" | "never" | "other";
};

export type RoundPlan = { round?: string; demands: number[]; bids: BidPlan[]; reserve?: bigint; hosts?: number };

/** Plays one round through a real Coordinator on a manual clock and returns what it publishes. */
export function playRound(plan: RoundPlan): { file: RoundFile; coordinator: Coordinator; clock: ManualClock } {
  const round = plan.round ?? "test-r1";
  const clock = new ManualClock(1_000);
  const coordinator = new Coordinator({ clock });
  const sellers = Math.max(1, ...plan.bids.map((b) => b.seller));
  const params = coordinator.open({
    round,
    roundNumber: 1,
    reserveUnitPrice: (plan.reserve ?? RESERVE).toString(),
    storage: { every: 2, price: "60000" },
    data: { every: 4, price: "80000" },
    roster: rosterOf(plan.demands.length, sellers, plan.hosts ?? 1),
    poolWindow: 1_000,
    commitWindow: 1_000,
    revealWindow: 1_000,
  });
  const tick = () => clock.set(clock.now() + 10);
  plan.demands.forEach((units, i) => {
    if (units === 0) return;
    tick();
    const body = { buyer: buyer(i + 1), units, maxUnitPrice: (plan.reserve ?? RESERVE).toString() };
    coordinator.demand(round, { ...body, sig: signMessage(keyOf(body.buyer).secretKey, "demand", round, body.buyer, demandFields(body)) });
  });
  clock.set(params.poolDeadline);
  for (const b of plan.bids) {
    tick();
    const who = seller(b.seller);
    const commitment = commitmentOf(round, who, { unitPrice: b.unitPrice, capacity: b.capacity, salt: salt(b.seller) });
    coordinator.commit(round, { seller: who, commitment, sig: signMessage(keyOf(who).secretKey, "commit", round, who, commitFields({ commitment })) });
  }
  clock.set(params.commitDeadline);
  const reveal = (b: BidPlan) => {
    tick();
    const who = seller(b.seller);
    const body = { seller: who, unitPrice: (b.reveal === "other" ? b.unitPrice - 1_000n : b.unitPrice).toString(), capacity: b.capacity, salt: salt(b.seller) };
    coordinator.reveal(round, { ...body, sig: signMessage(keyOf(who).secretKey, "reveal", round, who, revealFields(body)) });
  };
  for (const b of plan.bids) if ((b.reveal ?? "on-time") === "on-time" || b.reveal === "other") reveal(b);
  clock.set(params.revealDeadline);
  for (const b of plan.bids) if (b.reveal === "late") reveal(b);
  tick();
  return { file: coordinator.close(round), coordinator, clock };
}

/** A deep copy a test can change without touching the original. */
export const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
