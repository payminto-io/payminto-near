/**
 * The coordinator: a small HTTP service that opens rounds, accepts signed demand, commitments and reveals inside their
 * phases, closes a round and publishes its round file. It holds no keys and moves no tokens. Its fairness is checkable
 * from the round file (`verifyRound`), not enforced by a contract.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  commitFields,
  demandFields,
  evaluateRound,
  messageDigest,
  phaseAt,
  revealFields,
  ROUND_FILE_KIND,
  roundParamsSchema,
  zRoundId,
  MAX_CAPACITY,
  MAX_DEMAND_UNITS,
  type Phase,
  type RoundFile,
  type RoundMessage,
  type RoundParams,
  type RoundResult,
} from "./rules.ts";
import { isAccountId, isId32, isSig64, verifyDigest, type AccountId } from "@payminto/protocol";

/** The coordinator's time. A simulation passes a counter it advances itself; a live service passes the wall clock. */
export interface Clock {
  now(): number;
}

export class ManualClock implements Clock {
  #t: number;
  constructor(start = 0) {
    this.#t = start;
  }
  now(): number {
    return this.#t;
  }
  /** Moves the clock forward. Time never runs backwards. */
  set(t: number): void {
    if (t > this.#t) this.#t = t;
  }
}

export const wallClock: Clock = { now: () => Date.now() };

export class CoordinatorError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422;
  readonly code: string;
  constructor(status: 400 | 401 | 403 | 404 | 409 | 422, code: string, message: string) {
    super(message);
    this.name = "CoordinatorError";
    this.status = status;
    this.code = code;
  }
}

export type CoordinatorEvent =
  | { type: "opened"; params: RoundParams }
  | { type: "message"; round: string; message: RoundMessage; late: boolean }
  | { type: "closed"; file: RoundFile };

type RoundState = { params: RoundParams; messages: RoundMessage[]; file: RoundFile | null };

const zAccount = z.string().refine(isAccountId, "must be a NEAR account id");
const zSig = z.string().refine(isSig64, "must be 128 lowercase hex characters");
const zAtomic = z.string().regex(/^[1-9][0-9]{0,29}$/, "must be a positive decimal integer");
export const demandBody = z.object({ buyer: zAccount, units: z.number().int().min(1).max(MAX_DEMAND_UNITS), maxUnitPrice: zAtomic, sig: zSig });
export const commitBody = z.object({ seller: zAccount, commitment: z.string().refine(isId32, "must be 64 lowercase hex characters"), sig: zSig });
export const revealBody = z.object({ seller: zAccount, unitPrice: zAtomic, capacity: z.number().int().min(1).max(MAX_CAPACITY), salt: z.string().refine(isId32, "must be 64 lowercase hex characters"), sig: zSig });
/** The opener gives windows, not timestamps, so the deadlines are set by the coordinator's own clock. */
export const openBody = roundParamsSchema
  .omit({ openedAt: true, poolDeadline: true, commitDeadline: true, revealDeadline: true })
  .extend({ poolWindow: z.number().int().min(1), commitWindow: z.number().int().min(1), revealWindow: z.number().int().min(1) });
export type OpenRound = z.infer<typeof openBody>;

export type RoundView = {
  round: string;
  phase: Phase;
  now: number;
  params: RoundParams;
  pooledUnits: number;
  demands: Array<{ seq: number; buyer: AccountId; units: number }>;
  commitments: Array<{ seq: number; seller: AccountId; commitment: string }>;
  reveals: Array<{ seq: number; seller: AccountId; unitPrice: string; capacity: number; late: boolean }>;
  result: RoundResult | null;
};

export class Coordinator {
  readonly #clock: Clock;
  readonly #rounds = new Map<string, RoundState>();
  readonly #listeners = new Set<(e: CoordinatorEvent) => void>();

  constructor(o: { clock?: Clock } = {}) {
    this.#clock = o.clock ?? wallClock;
  }

  on(listener: (e: CoordinatorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(e: CoordinatorEvent): void {
    for (const l of this.#listeners) l(e);
  }

  #round(id: string): RoundState {
    const r = this.#rounds.get(id);
    if (!r) throw new CoordinatorError(404, "UNKNOWN_ROUND", `no round ${id}; GET /rounds lists the rounds this coordinator knows`);
    return r;
  }

  open(o: OpenRound): RoundParams {
    if (this.#rounds.has(o.round)) throw new CoordinatorError(409, "ROUND_EXISTS", `round ${o.round} is already open or closed; use a new round id`);
    const accounts = new Set(o.roster.map((r) => r.account));
    if (accounts.size !== o.roster.length) throw new CoordinatorError(422, "DUPLICATE_ACCOUNT", "an account appears twice on the roster");
    if (new Set(o.roster.map((r) => r.publicKey)).size !== o.roster.length) throw new CoordinatorError(422, "DUPLICATE_KEY", "two roster entries share one key; every agent needs its own");
    const openedAt = this.#clock.now();
    const { poolWindow, commitWindow, revealWindow, ...rest } = o;
    const params: RoundParams = { ...rest, openedAt, poolDeadline: openedAt + poolWindow, commitDeadline: openedAt + poolWindow + commitWindow, revealDeadline: openedAt + poolWindow + commitWindow + revealWindow };
    this.#rounds.set(o.round, { params, messages: [], file: null });
    this.#emit({ type: "opened", params });
    return params;
  }

  /** Checks the phase, the roster and the signature, then records the message with the next sequence number. */
  #accept(id: string, kind: RoundMessage["kind"], account: AccountId, fields: ReadonlyArray<string | number>, sig: string, phases: readonly Phase[], build: (stamp: { seq: number; at: number; sig: string }) => RoundMessage): RoundMessage {
    const r = this.#round(id);
    const at = this.#clock.now();
    const phase = phaseAt(r.params, at, r.file !== null);
    if (!phases.includes(phase)) {
      const when: Record<RoundMessage["kind"], string> = {
        demand: `demand is accepted before the pool deadline (${r.params.poolDeadline})`,
        commit: `commitments are accepted from the pool deadline (${r.params.poolDeadline}) until the commit deadline (${r.params.commitDeadline})`,
        reveal: `reveals are accepted from the commit deadline (${r.params.commitDeadline}), and count until the reveal deadline (${r.params.revealDeadline})`,
      };
      throw new CoordinatorError(409, "WRONG_PHASE", `round ${id} is in the ${phase} phase at ${at}; ${when[kind]}`);
    }
    const entry = r.params.roster.find((e) => e.account === account);
    const role = kind === "demand" ? "buyer" : "seller";
    if (!entry) throw new CoordinatorError(403, "NOT_ON_ROSTER", `${account} is not on the roster of round ${id}`);
    if (entry.role !== role) throw new CoordinatorError(403, "WRONG_ROLE", `${account} is a ${entry.role}; only a ${role} can send a ${kind}`);
    if (!verifyDigest(entry.publicKey, messageDigest(kind, id, account, fields), sig)) {
      throw new CoordinatorError(401, "BAD_SIGNATURE", `the ${kind} is not signed by the roster key of ${account}`);
    }
    const mine = (m: RoundMessage) => m.kind === kind && (m.kind === "demand" ? m.buyer : m.seller) === account;
    if (r.messages.some(mine)) throw new CoordinatorError(409, "DUPLICATE", `${account} already sent a ${kind} in round ${id}; only the first one counts`);
    const message = build({ seq: r.messages.length + 1, at, sig });
    r.messages.push(message);
    this.#emit({ type: "message", round: id, message, late: phase === "late" });
    return message;
  }

  demand(id: string, b: z.infer<typeof demandBody>): RoundMessage {
    const r = this.#round(id);
    if (BigInt(b.maxUnitPrice) < BigInt(r.params.reserveUnitPrice)) {
      throw new CoordinatorError(422, "UNDER_RESERVE", `the limit ${b.maxUnitPrice} is under the reserve ${r.params.reserveUnitPrice}; the pool only takes buyers who accept any price up to the reserve`);
    }
    return this.#accept(id, "demand", b.buyer, demandFields(b), b.sig, ["pooling"], (s) => ({ kind: "demand", ...s, buyer: b.buyer, units: b.units, maxUnitPrice: b.maxUnitPrice }));
  }

  commit(id: string, b: z.infer<typeof commitBody>): RoundMessage {
    return this.#accept(id, "commit", b.seller, commitFields(b), b.sig, ["commit"], (s) => ({ kind: "commit", ...s, seller: b.seller, commitment: b.commitment }));
  }

  reveal(id: string, b: z.infer<typeof revealBody>): RoundMessage {
    const r = this.#round(id);
    if (!r.messages.some((m) => m.kind === "commit" && m.seller === b.seller)) {
      throw new CoordinatorError(409, "NO_COMMITMENT", `${b.seller} has no commitment in round ${id}, so there is nothing to reveal`);
    }
    // A late reveal is recorded, so the round file shows why the bid is void.
    return this.#accept(id, "reveal", b.seller, revealFields(b), b.sig, ["reveal", "late"], (s) => ({ kind: "reveal", ...s, seller: b.seller, unitPrice: b.unitPrice, capacity: b.capacity, salt: b.salt }));
  }

  /** Computes and publishes the result. Asking again returns the same round file. */
  close(id: string): RoundFile {
    const r = this.#round(id);
    if (r.file) return r.file;
    const at = this.#clock.now();
    if (at < r.params.revealDeadline) {
      throw new CoordinatorError(409, "TOO_EARLY", `round ${id} can close from the reveal deadline (${r.params.revealDeadline}); it is ${at} now`);
    }
    const file: RoundFile = { kind: ROUND_FILE_KIND, params: r.params, messages: [...r.messages], result: { ...evaluateRound(r.params, r.messages), closedAt: at } };
    r.file = file;
    this.#emit({ type: "closed", file });
    return file;
  }

  view(id: string): RoundView {
    const r = this.#round(id);
    const now = this.#clock.now();
    const pick = <K extends RoundMessage["kind"]>(kind: K) => r.messages.filter((m): m is Extract<RoundMessage, { kind: K }> => m.kind === kind);
    const demands = pick("demand").map((m) => ({ seq: m.seq, buyer: m.buyer, units: m.units }));
    return {
      round: id,
      phase: phaseAt(r.params, now, r.file !== null),
      now,
      params: r.params,
      pooledUnits: demands.reduce((s, d) => s + d.units, 0),
      demands,
      commitments: pick("commit").map((m) => ({ seq: m.seq, seller: m.seller, commitment: m.commitment })),
      reveals: pick("reveal").map((m) => ({ seq: m.seq, seller: m.seller, unitPrice: m.unitPrice, capacity: m.capacity, late: m.at >= r.params.revealDeadline })),
      result: r.file?.result ?? null,
    };
  }

  list(): Array<Pick<RoundView, "round" | "phase" | "pooledUnits"> & { reserveUnitPrice: string }> {
    return [...this.#rounds.keys()].map((id) => {
      const v = this.view(id);
      return { round: id, phase: v.phase, pooledUnits: v.pooledUnits, reserveUnitPrice: v.params.reserveUnitPrice };
    });
  }

  file(id: string): RoundFile {
    const r = this.#round(id);
    if (!r.file) throw new CoordinatorError(409, "NOT_CLOSED", `round ${id} is not closed yet; its round file is published at the close`);
    return r.file;
  }
}

/**
 * The HTTP face of a coordinator. Opening a round needs the opener token when one is set; everything else is open,
 * because every message is authenticated by its own signature.
 */
export function coordinatorApp(c: Coordinator, o: { openerToken?: string } = {}): Hono {
  const app = new Hono();
  const parse = async <T>(req: Request, schema: z.ZodType<T>): Promise<T> => {
    const raw = await req.json().catch(() => {
      throw new CoordinatorError(400, "BAD_JSON", "the body must be JSON");
    });
    const r = schema.safeParse(raw);
    if (!r.success) throw new CoordinatorError(400, "BAD_REQUEST", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    return r.data;
  };
  const id = (v: string): string => {
    if (!zRoundId.safeParse(v).success) throw new CoordinatorError(400, "BAD_ROUND_ID", "a round id is lowercase letters, digits and single hyphens");
    return v;
  };
  app.onError((err, ctx) => {
    if (err instanceof CoordinatorError) return ctx.json({ error: { code: err.code, message: err.message } }, err.status);
    return ctx.json({ error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } }, 500);
  });
  app.get("/rounds", (ctx) => ctx.json(c.list()));
  app.post("/rounds", async (ctx) => {
    if (o.openerToken && ctx.req.header("authorization") !== `Bearer ${o.openerToken}`) throw new CoordinatorError(401, "UNAUTHORIZED", "opening a round needs the opener token");
    return ctx.json(c.open(await parse(ctx.req.raw, openBody)), 201);
  });
  app.get("/rounds/:id", (ctx) => ctx.json(c.view(id(ctx.req.param("id")))));
  app.get("/rounds/:id/log", (ctx) => ctx.json(c.file(id(ctx.req.param("id")))));
  app.post("/rounds/:id/demand", async (ctx) => ctx.json(c.demand(id(ctx.req.param("id")), await parse(ctx.req.raw, demandBody)), 201));
  app.post("/rounds/:id/commit", async (ctx) => ctx.json(c.commit(id(ctx.req.param("id")), await parse(ctx.req.raw, commitBody)), 201));
  app.post("/rounds/:id/reveal", async (ctx) => ctx.json(c.reveal(id(ctx.req.param("id")), await parse(ctx.req.raw, revealBody)), 201));
  app.post("/rounds/:id/close", (ctx) => ctx.json(c.close(id(ctx.req.param("id")))));
  return app;
}
