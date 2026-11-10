/**
 * The agents of the swarm. Each one holds its own ed25519 key and pays through the real SDK client against its own
 * Budget; sellers and data hosts serve through the real SDK paywall. Behaviour is scripted (scenario.ts): no model call.
 */
import { Hono } from "hono";
import { HEADER_RESPONSE, sha256Text, type AccountId, type ClearingReceipt, type Id32, type Policy } from "@payminto/protocol";
import { AgentClient, type DeniedEvent, type Paywall } from "@payminto/sdk";
import { commitFields, commitmentOf, demandFields, revealFields, signMessage, type DeliveryStop } from "./rules.ts";
import type { BuyerSpec, SellerPlan, SellerSpec } from "./scenario.ts";

/** One refusal as the paying agent saw it: the rule, who enforced it, and what was attempted. */
export type RefusalSeen = {
  agent: AccountId;
  /** What the agent was trying to buy. */
  item: "gpu" | "storage" | "data";
  round: string;
  rule: string;
  enforcedBy: "agent" | "node";
  attemptedAmount: string | null;
  remainingBudget: string | null;
  /** The machine-readable retry hint kind: never, after, after_settlement, fund or resign. */
  retry: string | null;
};

export type BudgetFacts = { budgetId: Id32; cap: bigint; escrow: bigint; policy: Policy; payees: AccountId[] };

export type PaidCall = { receipt: ClearingReceipt; item: RefusalSeen["item"]; round: string };

export type ClientOptions = { network: AgentClient["network"]; hub: AccountId; nodeUrl: string; trustedNodeKey: AgentClient["publicKey"] };

/** Thrown when the coordinator rejects a message. Carries its code, so a scripted strategy can tell why. */
export class CoordinatorRejected extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CoordinatorRejected";
    this.status = status;
    this.code = code;
  }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) throw new CoordinatorRejected(res.status, json?.error?.code ?? `HTTP_${res.status}`, json?.error?.message ?? `${url} answered HTTP ${res.status}`);
  return json;
}

abstract class Agent {
  readonly account: AccountId;
  readonly budget: BudgetFacts;
  readonly client: AgentClient;
  /** Every Call this agent paid for, in order, each with the receipt the node signed. */
  readonly paid: PaidCall[] = [];
  readonly refusals: RefusalSeen[] = [];
  #context: { item: RefusalSeen["item"]; round: string } = { item: "gpu", round: "" };
  protected lastReceipt: ClearingReceipt | null = null;
  protected lastRefusal: RefusalSeen | null = null;

  constructor(account: AccountId, secret: BuyerSpec["key"], budget: BudgetFacts, o: ClientOptions) {
    this.account = account;
    this.budget = budget;
    // Calls go one at a time, so a re-sign after a stale position needs no backoff.
    this.client = new AgentClient({ ...o, keypair: secret, budgetId: budget.budgetId, sleep: async () => {} });
    this.client.on("receipt", (e) => {
      this.lastReceipt = e.receipt;
      this.paid.push({ receipt: e.receipt, ...this.#context });
    });
    this.client.on("denied", (d: DeniedEvent) => {
      const r: RefusalSeen = {
        agent: this.account,
        ...this.#context,
        rule: d.code,
        enforcedBy: d.details?.enforcedBy === "agent" ? "agent" : "node",
        attemptedAmount: d.refusal?.attemptedAmount ?? null,
        remainingBudget: d.refusal?.remainingBudget ?? null,
        retry: d.refusal?.retry?.kind ?? null,
      };
      this.lastRefusal = r;
      this.refusals.push(r);
    });
  }

  /** One paid request through the SDK client. The response is returned whatever its status. */
  protected async pay(url: string, item: RefusalSeen["item"], round: string): Promise<Response> {
    this.#context = { item, round };
    this.lastReceipt = null;
    this.lastRefusal = null;
    return this.client.fetch(url);
  }

  /** What this agent paid to one Payee for one kind of item in one round, from its own verified receipts. */
  paidTo(payee: AccountId, item: RefusalSeen["item"], round: string): { calls: number; amount: bigint } {
    const mine = this.paid.filter((p) => p.receipt.payee === payee && p.item === item && p.round === round);
    return { calls: mine.length, amount: mine.reduce((s, p) => s + BigInt(p.receipt.amount), 0n) };
  }
}

export type UnitOutcome = { kind: "delivered"; receipt: ClearingReceipt } | { kind: "stopped"; stop: Omit<DeliveryStop, "atUnit"> };

/** What a delivered unit looks like. The "work" is a hash, labelled as such: the swarm sells no real GPU time. */
export const unitOutput = (round: string, buyer: AccountId, n: number): string => sha256Text(`payminto.swarm.unit.v1|${round}|${buyer}|${n}`);

export class BuyerAgent extends Agent {
  readonly spec: BuyerSpec;
  /** Set for a data host once its shard endpoint is listening (rule I2). */
  dataUrl: string | null = null;
  shardsSold = 0;

  constructor(spec: BuyerSpec, budget: BudgetFacts, o: ClientOptions) {
    super(spec.account, spec.key, budget, o);
    this.spec = spec;
  }

  /** Rule 4: the signed demand. */
  async postDemand(coordinatorUrl: string, round: string, units: number, maxUnitPrice: bigint): Promise<void> {
    const body = { buyer: this.account, units, maxUnitPrice: maxUnitPrice.toString() };
    await post(`${coordinatorUrl}/rounds/${round}/demand`, { ...body, sig: signMessage(this.spec.key.secretKey, "demand", round, this.account, demandFields(body)) });
  }

  /** Rule 10: one unit, one paid Call. Anything but the unit itself stops the buyer for the round. */
  async buyUnit(sellerUrl: string, round: string, n: number): Promise<UnitOutcome> {
    const res = await this.pay(`${sellerUrl}/gpu/${round}/unit?buyer=${encodeURIComponent(this.account)}&n=${n}`, "gpu", round);
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as { round?: string; n?: number; output?: string } | null;
      if (this.lastReceipt && body?.round === round && body.n === n && body.output === unitOutput(round, this.account, n)) return { kind: "delivered", receipt: this.lastReceipt };
      return { kind: "stopped", stop: { cause: "unit-missing", rule: null, enforcedBy: null, attemptedAmount: null, remainingBudget: null } };
    }
    await res.body?.cancel();
    const r = this.lastRefusal;
    if (res.status === 402 && r) return { kind: "stopped", stop: { cause: "refused", rule: r.rule, enforcedBy: r.enforcedBy, attemptedAmount: r.attemptedAmount, remainingBudget: r.remainingBudget } };
    return { kind: "stopped", stop: { cause: "seller-unavailable", rule: null, enforcedBy: null, attemptedAmount: null, remainingBudget: null } };
  }

  /** The data host's server: one dataset shard per paid Call. */
  dataApp(pay: Paywall): Hono {
    const app = new Hono();
    app.get("/data/shard", pay.hono(), (c) => {
      this.shardsSold++;
      return c.json({ shard: sha256Text(`payminto.swarm.shard.v1|${this.account}|${c.req.query("round")}|${c.req.query("n")}`), host: this.account, note: "simulated dataset shard" });
    });
    return app;
  }
}

/** One round's delivery job on the winner's server. */
type Job = {
  round: string;
  pay: Paywall;
  /** Units this seller will serve before it stops: its awarded units, or fewer when it under-delivers. */
  limit: number;
  delivered: number;
  received: bigint;
  storage: { from: AccountId | null; url: string | null; every: number; count: number; paid: bigint };
  data: { from: AccountId | null; url: string | null; every: number; count: number; paid: bigint };
  inputRefused: { input: "storage" | "data"; rule: string } | null;
  onInput?: (input: "storage" | "data", from: AccountId, amount: bigint) => void;
};

export type JobStart = Pick<Job, "round" | "pay" | "limit" | "onInput"> & {
  storage: { from: AccountId | null; url: string | null; every: number };
  data: { from: AccountId | null; url: string | null; every: number };
};

export type JobReport = Pick<Job, "delivered" | "received" | "inputRefused"> & { storage: { from: AccountId | null; count: number; paid: bigint }; data: { from: AccountId | null; count: number; paid: bigint } };

export class SellerAgent extends Agent {
  readonly spec: SellerSpec;
  url = "";
  blocksSold = 0;
  readonly #jobs = new Map<string, Job>();

  constructor(spec: SellerSpec, budget: BudgetFacts, o: ClientOptions) {
    super(spec.account, spec.key, budget, o);
    this.spec = spec;
  }

  /** Rule 5: publish only the hash. */
  async commit(coordinatorUrl: string, round: string, plan: SellerPlan): Promise<string> {
    const commitment = commitmentOf(round, this.account, plan.bid);
    await post(`${coordinatorUrl}/rounds/${round}/commit`, { seller: this.account, commitment, sig: signMessage(this.spec.key.secretKey, "commit", round, this.account, commitFields({ commitment })) });
    return commitment;
  }

  /** Rule 5: open the bid. A scripted strategy may send something else than it committed to, or send it late. */
  async reveal(coordinatorUrl: string, round: string, bid: NonNullable<SellerPlan["reveal"]>): Promise<void> {
    const body = { seller: this.account, unitPrice: bid.unitPrice.toString(), capacity: bid.capacity, salt: bid.salt };
    await post(`${coordinatorUrl}/rounds/${round}/reveal`, { ...body, sig: signMessage(this.spec.key.secretKey, "reveal", round, this.account, revealFields(body)) });
  }

  beginDelivery(start: JobStart): void {
    this.#jobs.set(start.round, {
      ...start,
      delivered: 0,
      received: 0n,
      storage: { ...start.storage, count: 0, paid: 0n },
      data: { ...start.data, count: 0, paid: 0n },
      inputRefused: null,
    });
  }

  report(round: string): JobReport {
    const j = this.#jobs.get(round);
    if (!j) throw new Error(`${this.account} has no delivery job for ${round}`);
    return { delivered: j.delivered, received: j.received, inputRefused: j.inputRefused, storage: { from: j.storage.from, count: j.storage.count, paid: j.storage.paid }, data: { from: j.data.from, count: j.data.count, paid: j.data.paid } };
  }

  /** Rule 12: one input purchase, a paid Call from this seller's own Budget. False when it was refused. */
  async #buyInput(job: Job, input: "storage" | "data"): Promise<boolean> {
    const side = job[input];
    if (!side.from || !side.url) return true;
    const res = await this.pay(`${side.url}?round=${job.round}&seller=${encodeURIComponent(this.account)}&n=${side.count + 1}`, input, job.round);
    await res.body?.cancel();
    if (res.status !== 200 || !this.lastReceipt) {
      job.inputRefused = { input, rule: this.lastRefusal?.rule ?? `HTTP_${res.status}` };
      return false;
    }
    side.count++;
    side.paid += BigInt(this.lastReceipt.amount);
    job.onInput?.(input, side.from, BigInt(this.lastReceipt.amount));
    return true;
  }

  /** The seller's server: GPU units for the rounds it won, and storage blocks for the seller it supplies. */
  app(storagePay: Paywall | null): Hono {
    const app = new Hono();
    app.get("/gpu/:round/unit", async (c) => {
      const job = this.#jobs.get(c.req.param("round"));
      if (!job) return c.json({ error: { code: "NOT_THE_WINNER", message: `${this.account} did not win this round, so it delivers nothing for it` } }, 404);
      // Rule 10: out of capacity is answered before the paywall, so no voucher is signed and no money moves.
      if (job.inputRefused || job.delivered >= job.limit) {
        return c.json({ error: { code: "SELLER_UNAVAILABLE", message: `${this.account} stopped serving after ${job.delivered} units` } }, 503);
      }
      const buyer = c.req.query("buyer") ?? "";
      const n = Number(c.req.query("n"));
      // The paywall answers 402 until the clearing node has accepted a voucher for exactly the clearing price.
      const paid = await job.pay.check(c.req.raw);
      if (!paid.ok) return paid.response;
      job.delivered++;
      job.received += BigInt(paid.paid.receipt.amount);
      // Rule 12: checkpoints and data are bought as the units go out.
      if (job.delivered % job.storage.every !== 0 || (await this.#buyInput(job, "storage"))) {
        if (job.delivered % job.data.every === 0) await this.#buyInput(job, "data");
      }
      return c.json(
        { round: job.round, buyer, n, seller: this.account, output: unitOutput(job.round, buyer, n), note: "simulated GPU-hour: the output is a hash, no GPU ran" },
        200,
        { [HEADER_RESPONSE]: paid.responseHeader, "access-control-expose-headers": HEADER_RESPONSE },
      );
    });
    if (storagePay) {
      app.get("/storage/block", storagePay.hono(), (c) => {
        this.blocksSold++;
        return c.json({ block: sha256Text(`payminto.swarm.block.v1|${this.account}|${c.req.query("round")}|${c.req.query("seller")}|${c.req.query("n")}`), supplier: this.account, note: "simulated checkpoint storage block" });
      });
    }
    return app;
  }
}
