/**
 * What a run simulates: how many agents, which scripted strategies, the posted prices, and every seeded number.
 * Nothing here is random at run time: each value is a SHA-256 of the seed and a label, so one seed gives one run.
 */
import { z } from "zod";
import { keypairFromSeed, sha256Text, type AccountId, type Keypair } from "@payminto/protocol";
import { apportion } from "./rules.ts";

export const SELLER_STRATEGIES = ["truthful", "shading", "late", "withhold", "underdeliver", "mismatch"] as const;
export type SellerStrategy = (typeof SELLER_STRATEGIES)[number];
export const BUYER_STRATEGIES = ["steady", "capped", "thin"] as const;
export type BuyerStrategy = (typeof BUYER_STRATEGIES)[number];

export const STRATEGY_TEXT: Record<SellerStrategy | BuyerStrategy, string> = {
  truthful: "seller: bids its real cost per unit and reveals on time",
  shading: "seller: bids its cost plus 15 percent and reveals on time",
  late: "seller: bids its cost, and reveals after the deadline in odd rounds (1, 3, 5 ...)",
  withhold: "seller: bids its cost, and never reveals in even rounds (2, 4, 6 ...)",
  underdeliver: "seller: bids its cost, and when it wins stops serving after 60 percent of the awarded units",
  mismatch: "seller: commits to its cost, then reveals a price 10 percent lower, which does not match",
  steady: "buyer: its Budget covers everything it asks for",
  capped: "buyer: asks for 6 units a round, but its Budget cap covers only 2.5 units at the reserve price",
  thin: "buyer: asks for 6 units a round, but its Budget escrow covers only 2.5 units at the reserve price",
};

export type Mix<S extends string> = Array<{ strategy: S; weight: number }>;

export type Scenario = {
  seed: number;
  buyers: number;
  sellers: number;
  rounds: number;
  /** How many of the first buyers also sell dataset shards (rule I2). */
  dataHosts: number;
  sellerMix: Mix<SellerStrategy>;
  buyerMix: Mix<BuyerStrategy>;
  /** Atomic USDC per unit: no bid above this is valid, and it is the price when only one bid is valid. */
  reserveUnitPrice: bigint;
  storage: { every: number; price: bigint };
  data: { every: number; price: bigint };
  /** Units a buyer asks for in a round, drawn per buyer and round. */
  demand: { min: number; max: number };
  /** A seller's cost per unit in atomic USDC, drawn per seller, then moved a little per round. */
  cost: { min: bigint; max: bigint };
};

export const DEFAULT_SELLER_MIX: Mix<SellerStrategy> = [
  { strategy: "truthful", weight: 1 },
  { strategy: "shading", weight: 1 },
  { strategy: "late", weight: 1 },
  { strategy: "withhold", weight: 1 },
  { strategy: "underdeliver", weight: 1 },
];
export const DEFAULT_BUYER_MIX: Mix<BuyerStrategy> = [
  { strategy: "steady", weight: 18 },
  { strategy: "capped", weight: 1 },
  { strategy: "thin", weight: 1 },
];

export const DEFAULTS = {
  seed: 51,
  buyers: 20,
  sellers: 5,
  rounds: 3,
  reserveUnitPrice: 700_000n,
  storage: { every: 2, price: 60_000n },
  data: { every: 4, price: 80_000n },
  demand: { min: 2, max: 6 },
  cost: { min: 380_000n, max: 520_000n },
} as const;

export const LIMITS = {
  buyers: { min: 1, max: 60 },
  /** A Budget lists at most 16 Payees, and a buyer's Budget lists every seller. */
  sellers: { min: 1, max: 16 },
  rounds: { min: 1, max: 12 },
  /** A seller's Budget lists its storage supplier and every data host: 1 + 15. */
  dataHosts: { min: 0, max: 15 },
  seed: { min: 0, max: 4_294_967_295 },
} as const;

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

export const defaultDataHosts = (buyers: number): number => Math.min(4, Math.floor(buyers / 5), LIMITS.dataHosts.max);

/** `truthful:2,shading,late:1`: strategy names with optional whole-number weights. */
export function parseMix<S extends string>(text: string, known: readonly S[], who: "seller" | "buyer"): Mix<S> {
  const out: Mix<S> = [];
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [name, w = "1", extra] = part.split(":");
    const hint = `${who} strategies are ${known.join(", ")}; write them as name:weight, for example ${known[0]}:2,${known[1] ?? known[0]}:1`;
    if (extra !== undefined || !name) throw new ScenarioError(`cannot read "${part}" in the ${who} mix; ${hint}`);
    if (!(known as readonly string[]).includes(name)) throw new ScenarioError(`"${name}" is not a ${who} strategy; ${hint}`);
    if (!/^[0-9]{1,4}$/.test(w)) throw new ScenarioError(`the weight of ${name} must be a whole number from 0 to 9999, not "${w}"; ${hint}`);
    if (out.some((m) => m.strategy === name)) throw new ScenarioError(`${name} appears twice in the ${who} mix; give it one weight`);
    out.push({ strategy: name as S, weight: Number(w) });
  }
  if (out.every((m) => m.weight === 0)) throw new ScenarioError(`the ${who} mix needs at least one strategy with a weight above 0`);
  return out;
}

/** `sellers=truthful:2,shading:1 buyers=steady:8,capped:1`: one or both sides, separated by a space or a semicolon. */
export function parseStrategyMix(text: string): { sellerMix?: Mix<SellerStrategy>; buyerMix?: Mix<BuyerStrategy> } {
  const out: { sellerMix?: Mix<SellerStrategy>; buyerMix?: Mix<BuyerStrategy> } = {};
  const parts = text.split(/[;\s]+/).filter(Boolean);
  const usage = 'write it as "sellers=truthful:2,shading:1 buyers=steady:8,capped:1,thin:1" (either side may be left out)';
  if (parts.length === 0) throw new ScenarioError(`--strategy-mix is empty; ${usage}`);
  for (const part of parts) {
    const eq = part.indexOf("=");
    const side = eq < 0 ? "" : part.slice(0, eq);
    if (side === "sellers") out.sellerMix = parseMix(part.slice(eq + 1), SELLER_STRATEGIES, "seller");
    else if (side === "buyers") out.buyerMix = parseMix(part.slice(eq + 1), BUYER_STRATEGIES, "buyer");
    else throw new ScenarioError(`cannot read "${part}" in --strategy-mix; ${usage}`);
  }
  return out;
}

const mixSchema = <S extends string>(known: readonly S[]) =>
  z.partialRecord(z.enum(known as unknown as [S, ...S[]]), z.number().int().min(0).max(9_999)).transform((r) => Object.entries(r).map(([strategy, weight]) => ({ strategy: strategy as S, weight: weight as number })));
const usdcText = z.string().regex(/^[0-9]+(\.[0-9]{1,6})?$/, "must be a USDC amount such as 0.70, with at most 6 decimals");
const toAtomic = (v: string): bigint => {
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
};

/** A scenario file: every field is optional and falls back to the default. Prices are USDC as decimal strings. */
export const scenarioFileSchema = z
  .object({
    seed: z.number().int().min(LIMITS.seed.min).max(LIMITS.seed.max),
    buyers: z.number().int().min(LIMITS.buyers.min).max(LIMITS.buyers.max),
    sellers: z.number().int().min(LIMITS.sellers.min).max(LIMITS.sellers.max),
    rounds: z.number().int().min(LIMITS.rounds.min).max(LIMITS.rounds.max),
    dataHosts: z.number().int().min(LIMITS.dataHosts.min).max(LIMITS.dataHosts.max),
    sellerStrategies: mixSchema(SELLER_STRATEGIES),
    buyerStrategies: mixSchema(BUYER_STRATEGIES),
    reserveUnitPrice: usdcText,
    storage: z.object({ every: z.number().int().min(1).max(1_000), price: usdcText }).strict(),
    data: z.object({ every: z.number().int().min(1).max(1_000), price: usdcText }).strict(),
    demand: z.object({ min: z.number().int().min(1).max(1_000), max: z.number().int().min(1).max(1_000) }).strict(),
    sellerCost: z.object({ min: usdcText, max: usdcText }).strict(),
  })
  .partial()
  .strict();
export type ScenarioFile = z.infer<typeof scenarioFileSchema>;

export type ScenarioOverrides = Partial<Pick<Scenario, "seed" | "buyers" | "sellers" | "rounds" | "dataHosts" | "sellerMix" | "buyerMix">>;

/** Defaults, then the scenario file, then the flags. Throws ScenarioError with what to change. */
export function buildScenario(file: ScenarioFile = {}, flags: ScenarioOverrides = {}): Scenario {
  const buyers = flags.buyers ?? file.buyers ?? DEFAULTS.buyers;
  const s: Scenario = {
    seed: flags.seed ?? file.seed ?? DEFAULTS.seed,
    buyers,
    sellers: flags.sellers ?? file.sellers ?? DEFAULTS.sellers,
    rounds: flags.rounds ?? file.rounds ?? DEFAULTS.rounds,
    dataHosts: flags.dataHosts ?? file.dataHosts ?? defaultDataHosts(buyers),
    sellerMix: flags.sellerMix ?? file.sellerStrategies ?? DEFAULT_SELLER_MIX,
    buyerMix: flags.buyerMix ?? file.buyerStrategies ?? DEFAULT_BUYER_MIX,
    reserveUnitPrice: file.reserveUnitPrice ? toAtomic(file.reserveUnitPrice) : DEFAULTS.reserveUnitPrice,
    storage: file.storage ? { every: file.storage.every, price: toAtomic(file.storage.price) } : { ...DEFAULTS.storage },
    data: file.data ? { every: file.data.every, price: toAtomic(file.data.price) } : { ...DEFAULTS.data },
    demand: file.demand ?? { ...DEFAULTS.demand },
    cost: file.sellerCost ? { min: toAtomic(file.sellerCost.min), max: toAtomic(file.sellerCost.max) } : { ...DEFAULTS.cost },
  };
  const range = (name: keyof typeof LIMITS, v: number, flag: string) => {
    const l = LIMITS[name];
    if (!Number.isInteger(v) || v < l.min || v > l.max) throw new ScenarioError(`${flag} must be a whole number from ${l.min} to ${l.max}, not ${v}`);
  };
  range("seed", s.seed, "--seed");
  range("buyers", s.buyers, "--buyers");
  range("sellers", s.sellers, "--sellers");
  range("rounds", s.rounds, "--rounds");
  range("dataHosts", s.dataHosts, "--data-hosts");
  if (s.dataHosts > s.buyers) throw new ScenarioError(`--data-hosts is ${s.dataHosts} but there are only ${s.buyers} buyers; data hosts are buyers, so lower it or raise --buyers`);
  if (s.demand.min > s.demand.max) throw new ScenarioError(`demand.min (${s.demand.min}) is above demand.max (${s.demand.max}); swap them`);
  if (s.cost.min > s.cost.max) throw new ScenarioError("sellerCost.min is above sellerCost.max; swap them");
  if (s.cost.min <= 0n || s.reserveUnitPrice <= 0n || s.storage.price <= 0n || s.data.price <= 0n) throw new ScenarioError("every price in the scenario must be above 0");
  if (s.sellerMix.every((m) => m.weight === 0)) throw new ScenarioError("the seller strategies need at least one weight above 0");
  if (s.buyerMix.every((m) => m.weight === 0)) throw new ScenarioError("the buyer strategies need at least one weight above 0");
  return s;
}

// ---- seeded values ----

/** A whole number in [min, max], decided by the seed and the label alone. */
export function draw(seed: number, label: string, min: number, max: number): number {
  if (max < min) throw new Error("draw: max is under min");
  const h = BigInt(`0x${sha256Text(`payminto.swarm.draw.v1|${seed}|${label}`).slice(0, 16)}`);
  return min + Number(h % BigInt(max - min + 1));
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));

/** An ed25519 key derived from the seed. For simulation only: anyone who knows the seed knows the key. */
export const seededKey = (seed: number, account: AccountId): Keypair => keypairFromSeed(hexBytes(sha256Text(`payminto.swarm.key.v1|${seed}|${account}`)));
export const seededSalt = (seed: number, label: string): string => sha256Text(`payminto.swarm.salt.v1|${seed}|${label}`);

// ---- the agents of a run ----
// Demands, costs and capacities are drawn by an agent's role and number, not by its account, so one seed gives the same
// rounds on the simulated hub (swarm.testnet) and on a sandbox (swarm.test.near).

export type BuyerSpec = { role: "buyer"; index: number; account: AccountId; strategy: BuyerStrategy; dataHost: boolean; key: Keypair };
export type SellerSpec = { role: "seller"; index: number; account: AccountId; strategy: SellerStrategy; key: Keypair; baseCost: bigint };
export type AgentSpec = BuyerSpec | SellerSpec;

/** Largest remainder over the weights, then in the order the mix lists them: `truthful:2,late:1` over 3 agents is truthful, truthful, late. */
export function assignStrategies<S extends string>(mix: Mix<S>, count: number): S[] {
  const live = mix.filter((m) => m.weight > 0);
  // Keys carry the list position, so ties go to the strategy listed first.
  const keyed = live.map((m, i) => ({ key: `${String(i).padStart(4, "0")}:${m.strategy}`, weight: m.weight, strategy: m.strategy }));
  const share = apportion(keyed, count);
  return keyed.flatMap((k) => Array.from({ length: share.get(k.key)! }, () => k.strategy));
}

const THOUSAND = 1_000n;
/** A price between min and max in steps of 0.001 USDC. */
const drawPrice = (seed: number, label: string, min: bigint, max: bigint): bigint => min + BigInt(draw(seed, label, 0, Number((max - min) / THOUSAND))) * THOUSAND;

export function agentsOf(s: Scenario, parent: AccountId): { buyers: BuyerSpec[]; sellers: SellerSpec[]; all: AgentSpec[] } {
  const buyerStrategies = assignStrategies(s.buyerMix, s.buyers);
  const sellerStrategies = assignStrategies(s.sellerMix, s.sellers);
  const buyers: BuyerSpec[] = buyerStrategies.map((strategy, i) => {
    const account = `buyer-${i + 1}.${parent}`;
    return { role: "buyer", index: i + 1, account, strategy, dataHost: i < s.dataHosts, key: seededKey(s.seed, account) };
  });
  const sellers: SellerSpec[] = sellerStrategies.map((strategy, i) => {
    const account = `seller-${i + 1}.${parent}`;
    return { role: "seller", index: i + 1, account, strategy, key: seededKey(s.seed, account), baseCost: drawPrice(s.seed, `cost|seller-${i + 1}`, s.cost.min, s.cost.max) };
  });
  return { buyers, sellers, all: [...buyers, ...sellers] };
}

/** What a buyer asks for in a round. The two constrained strategies always ask for 6, so their Budgets must refuse. */
export function demandOf(s: Scenario, b: BuyerSpec, roundNumber: number): number {
  if (b.strategy !== "steady") return 6;
  return draw(s.seed, `demand|buyer-${b.index}|${roundNumber}`, s.demand.min, s.demand.max);
}

/** The Budget cap and escrow multiple of the reserve price that the two constrained strategies get: 2.5 units. */
export const CONSTRAINED_BUDGET = (reserve: bigint): bigint => (reserve * 5n) / 2n;

/** A seller's cost per unit in a round: its base cost moved by up to 0.04 USDC either way, never under 0.001. */
export function costOf(s: Scenario, seller: SellerSpec, roundNumber: number): bigint {
  const moved = seller.baseCost + BigInt(draw(s.seed, `jitter|seller-${seller.index}|${roundNumber}`, -40, 40)) * THOUSAND;
  return moved < THOUSAND ? THOUSAND : moved;
}

/** Units a seller can deliver in a round: 75 to 125 percent of what the buyers are expected to ask for. */
export function capacityOf(s: Scenario, seller: SellerSpec, roundNumber: number): number {
  const expected = Math.max(1, Math.round((s.buyers * (s.demand.min + s.demand.max)) / 2));
  return Math.max(1, Math.round((expected * draw(s.seed, `capacity|seller-${seller.index}|${roundNumber}`, 75, 125)) / 100));
}

export type SellerPlan = {
  /** What the seller commits to. */
  bid: { unitPrice: bigint; capacity: number; salt: string };
  /** What it sends in the reveal phase, or null when it never reveals. */
  reveal: { unitPrice: bigint; capacity: number; salt: string } | null;
  /** True when the reveal is sent after the reveal deadline. */
  revealLate: boolean;
  /** How many of the awarded units it will serve if it wins: a share of them in percent. */
  servePercent: number;
};

/** The scripted behaviour of one seller in one round. No model is called. */
export function sellerPlan(s: Scenario, seller: SellerSpec, round: string, roundNumber: number): SellerPlan {
  const cost = costOf(s, seller, roundNumber);
  // A shaded bid is rounded down to a whole 0.001 USDC, like every cost.
  const unitPrice = seller.strategy === "shading" ? ((cost * 115n) / 100n / THOUSAND) * THOUSAND : cost;
  const bid = { unitPrice, capacity: capacityOf(s, seller, roundNumber), salt: seededSalt(s.seed, `${round}|${seller.account}`) };
  const odd = roundNumber % 2 === 1;
  return {
    bid,
    reveal: seller.strategy === "withhold" && !odd ? null : seller.strategy === "mismatch" ? { ...bid, unitPrice: ((unitPrice * 90n) / 100n / THOUSAND) * THOUSAND } : bid,
    revealLate: seller.strategy === "late" && odd,
    servePercent: seller.strategy === "underdeliver" ? 60 : 100,
  };
}

/** `swarm-s7-r1`: the seed is part of the id, so a commitment from one run cannot be replayed in another. */
export const roundIdOf = (seed: number, roundNumber: number): string => `swarm-s${seed}-r${roundNumber}`;
