/**
 * The payee check as the dashboard runs it: before an owner adds a Payee to a Budget, this browser reads the account
 * from NEAR with `@payminto/payee-check` and shows the package's verdict. The package is read-only and fails closed, so
 * a read that does not finish is a block verdict with the reason, never silence.
 *
 * The package is loaded with a dynamic import, here and nowhere else, so the rest of the dashboard never carries it.
 * Reading and judging are separate on purpose: the facts of an account are read once, and the lookalike signal is
 * judged again, with no further reads, whenever the Budget's other Payees change.
 */
import type { AccountId, Network } from "@payminto/protocol";
import type { CheckSources, PayeeFacts, Verdict, VerdictKind, VerdictView } from "@payminto/payee-check";
import { MOCK_MODE } from "./config";
import { READ_TIMEOUT_MS, proofRpcUrl } from "./near-reader";
import type { Info } from "./schemas";

/** What a check needs to know about this server: the network, the RPC this browser reads from, and the token. */
export type PayeeCheckContext = {
  network: Network;
  /** The same RPC the page reads proofs from. Null when the network has none configured. */
  rpcUrl: string | null;
  /** The settlement token from `/v1/info`. */
  token: AccountId;
};

export function payeeCheckContext(info: Info): PayeeCheckContext {
  const network = info.network.id as Network;
  return { network, rpcUrl: proofRpcUrl(network, info.network.rpc_url), token: info.token.address };
}

/** A verdict ready for a page: the package's verdict, its view in plain words, and where the facts came from. */
export type PayeeCheckResult = {
  verdict: Verdict;
  view: VerdictView;
  /** Where the facts were read from, in words, for the line under a verdict. */
  from: string;
  /** True when the facts are demo data in this browser. */
  demo: boolean;
  /** True when the chain could not be read, so the block says nothing about the Payee itself. */
  failed: boolean;
  /** The Budget's other Payees the name was compared with. */
  against: AccountId[];
};

/** The facts of one account, read once. `judge` is pure: it reads nothing. */
export type PayeeReading = {
  payee: string;
  judge(budgetPayees: readonly AccountId[]): PayeeCheckResult;
};

/** The check could not even load, so there is no verdict. The Payee stays out of the Budget. */
export class PayeeCheckUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super("The payee check could not load, so this Payee was not checked. Check your connection and check again.", options);
    this.name = "PayeeCheckUnavailable";
  }
}

type Package = typeof import("@payminto/payee-check");

/** The loaded package and what it reads from. `sources` is null when no check can run, and `missing` says why. */
export type PayeeCheckSetup = { pc: Package; sources: CheckSources | null; from: string; demo: boolean; missing: string | null };
type Loaded = PayeeCheckSetup;

const NEARBLOCKS_NETWORK: Partial<Record<Network, "testnet" | "mainnet">> = { "near:testnet": "testnet", "near:mainnet": "mainnet" };

const loaded = new Map<string, Promise<Loaded>>();

async function load(ctx: PayeeCheckContext): Promise<Loaded> {
  const pc = await import("@payminto/payee-check");
  if (MOCK_MODE) {
    const { demoPayeeSources } = await import("./mock/payee-check");
    return { pc, sources: await demoPayeeSources(ctx.token), from: "demo data in this browser (no network)", demo: true, missing: null };
  }
  if (!ctx.rpcUrl) return { pc, sources: null, from: "no NEAR RPC", demo: false, missing: "no NEAR RPC is configured for this network" };
  if (!pc.isAccountId(ctx.token)) return { pc, sources: null, from: ctx.rpcUrl, demo: false, missing: "the server named a settlement token that is not a NEAR account" };
  // NearBlocks indexes testnet and mainnet only. On a sandbox the age is listed under "not checked".
  const indexed = NEARBLOCKS_NETWORK[ctx.network];
  const rpc = ctx.rpcUrl.replace(/^https?:\/\//, "");
  return {
    pc,
    sources: {
      reader: new pc.RpcNearReader({ url: ctx.rpcUrl, timeoutMs: READ_TIMEOUT_MS }),
      token: ctx.token,
      ageSource: indexed ? pc.nearBlocksAgeSource({ network: indexed, timeoutMs: READ_TIMEOUT_MS }) : undefined,
      sourceTimeoutMs: READ_TIMEOUT_MS,
    },
    from: indexed ? `${rpc}, account age from NearBlocks` : rpc,
    demo: false,
    missing: null,
  };
}

function loadOnce(ctx: PayeeCheckContext): Promise<Loaded> {
  const key = `${ctx.network} ${ctx.rpcUrl ?? ""} ${ctx.token}`;
  let p = loaded.get(key);
  if (!p) {
    p = load(ctx);
    loaded.set(key, p);
    // A failed load is not kept, so "Check again" really tries again.
    p.catch(() => loaded.delete(key));
  }
  return p;
}

/**
 * Reads one account. It resolves for every payee text: a source that fails becomes an unknown fact inside the package,
 * and a check that cannot run at all becomes the package's own "could not check" block. It rejects only with
 * `PayeeCheckUnavailable`, when the check code itself could not load.
 */
export async function readPayee(ctx: PayeeCheckContext, request: { payee: string; payer?: AccountId | null }): Promise<PayeeReading> {
  let l: Loaded;
  try {
    l = await loadOnce(ctx);
  } catch (e) {
    throw new PayeeCheckUnavailable({ cause: e });
  }
  return readPayeeWith(l, request);
}

/** `readPayee` over a setup that is already loaded. It never rejects. */
export async function readPayeeWith(l: PayeeCheckSetup, request: { payee: string; payer?: AccountId | null }): Promise<PayeeReading> {
  const { pc } = l;
  const payer = request.payer && pc.isAccountId(request.payer) ? request.payer : null;
  const asked = { payee: request.payee, payer };
  let facts: PayeeFacts;
  if (!l.sources) facts = pc.unreadableFacts(asked, l.missing ?? "the check is not configured", Date.now());
  else {
    try {
      facts = await pc.collectFacts(l.sources, asked);
    } catch (e) {
      facts = pc.unreadableFacts(asked, pc.printable(e instanceof Error ? e.message : e, 120), Date.now());
    }
  }
  return {
    payee: request.payee,
    judge(budgetPayees) {
      // The lookalike signal compares with the Budget's other Payees; the Payee itself is never its own lookalike.
      const against = [...new Set(budgetPayees)].filter((p) => p !== request.payee && pc.isAccountId(p));
      const verdict = pc.evaluate({ ...facts, budgetPayees: against });
      return { verdict, view: pc.toView(verdict), from: l.from, demo: l.demo, failed: verdict.signals.some((s) => s.id === "check_failed"), against };
    },
  };
}

/** One whole check: read the account, then judge it against the Budget's other Payees. */
export async function checkPayee(ctx: PayeeCheckContext, request: { payee: string; payer?: AccountId | null; budgetPayees: readonly AccountId[] }): Promise<PayeeCheckResult> {
  return (await readPayee(ctx, request)).judge(request.budgetPayees);
}

// ---------------------------------------------------------------------------
// Verdicts the server sent
// ---------------------------------------------------------------------------

/**
 * A verdict the server holds, in the package's plain words. The server's verdict is shown as it is: nothing is read
 * and nothing is judged again here. Rejects with `PayeeCheckUnavailable` when the package could not load.
 */
export async function viewOfVerdict(verdict: Verdict): Promise<VerdictView> {
  try {
    return (await import("@payminto/payee-check")).toView(verdict);
  } catch (e) {
    throw new PayeeCheckUnavailable({ cause: e });
  }
}

/** The package's short name for each signal id, such as "New account". An id it does not know has no entry. */
export async function signalTitles(): Promise<Readonly<Record<string, string>>> {
  return (await import("@payminto/payee-check")).SIGNAL_TITLES;
}

// ---------------------------------------------------------------------------
// What the owner must do before a Payee is added
// ---------------------------------------------------------------------------

/** `none`: added quietly. `confirm`: a plain yes. `type_id`: the owner types the Payee's account id. */
export type Confirmation = "none" | "confirm" | "type_id";

export function confirmationFor(verdict: VerdictKind): Confirmation {
  return verdict === "allow" ? "none" : verdict === "warn" ? "confirm" : "type_id";
}

/** True when the typed text is the Payee's account id, character for character. Only outer spaces are forgiven. */
export function typedIdMatches(payee: string, typed: string): boolean {
  return typed.trim() === payee && payee.length > 0;
}

const WEIGHT: Record<VerdictKind, number> = { allow: 0, warn: 1, block: 2 };

/** True when what the owner acknowledged covers this verdict. Nothing covers a heavier verdict than the one they saw. */
export function covers(acknowledged: VerdictKind | null, verdict: VerdictKind): boolean {
  return verdict === "allow" || (acknowledged !== null && WEIGHT[acknowledged] >= WEIGHT[verdict]);
}

export type PayeeRowState =
  /** A check is running. The Payee is not in the Budget. */
  | "checking"
  /** The check could not load. The Payee is not in the Budget. */
  | "unavailable"
  /** In the Budget's terms. */
  | "added"
  /** Waits for a plain confirmation. */
  | "needs_confirm"
  /** Waits for the owner to type the account id. */
  | "needs_typed_id";

export type PayeeRow = {
  payee: AccountId;
  state: PayeeRowState;
  result: PayeeCheckResult | null;
  /** What the owner confirmed for this Payee, if anything. */
  acknowledged: VerdictKind | null;
  /** One sentence, set only when the check could not load. */
  problem: string | null;
};

type Entry = {
  payee: AccountId;
  run: number;
  /** False while the check waits for a reader. */
  started: boolean;
  checking: boolean;
  reading: PayeeReading | null;
  result: PayeeCheckResult | null;
  problem: string | null;
  acknowledged: VerdictKind | null;
  added: boolean;
};

export type PayeeReader = (payee: AccountId) => Promise<PayeeReading>;

const NO_ROWS: readonly PayeeRow[] = [];

/**
 * The Payees an owner has picked for a new Budget, each with its check and the owner's decision. A Payee is in the
 * Budget's terms only when its row says `added`: at once on allow, after a confirmation on warn, and after the owner
 * typed its account id on block. A Payee that was added keeps the verdict it was added under; one that still waits is
 * judged again whenever the added Payees change, so a lookalike of a Payee added a moment ago is caught.
 */
export class PayeeGate {
  #entries = new Map<AccountId, Entry>();
  #order: AccountId[] = [];
  #reader: PayeeReader | null = null;
  #rows: readonly PayeeRow[] = NO_ROWS;
  #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The rows in the order the Payees were given. The same array until something changes. */
  rows = (): readonly PayeeRow[] => this.#rows;

  /** Sets how accounts are read. Payees picked before a reader was known are checked now. */
  configure(reader: PayeeReader | null): void {
    this.#reader = reader;
    if (!reader) return;
    // Only the ones that never started: a check already under way finishes with the reader it began with.
    for (const e of this.#entries.values()) if (e.checking && !e.started) this.#start(e);
  }

  /** Makes the rows match the picked Payees: new ones are checked, and ones no longer picked are forgotten. */
  sync(selected: readonly AccountId[]): void {
    const next = [...new Set(selected)];
    const same = next.length === this.#order.length && next.every((p, i) => p === this.#order[i]);
    if (same) return;
    for (const [payee, e] of this.#entries) {
      if (next.includes(payee)) continue;
      e.run++;
      this.#entries.delete(payee);
    }
    this.#order = next;
    for (const payee of next) {
      if (this.#entries.has(payee)) continue;
      const e: Entry = { payee, run: 0, started: false, checking: true, reading: null, result: null, problem: null, acknowledged: null, added: false };
      this.#entries.set(payee, e);
      this.#start(e);
    }
    this.#settle();
  }

  /**
   * The owner's yes. On warn a plain confirmation is enough; on block `typed` must be the Payee's account id.
   * Returns whether the Payee is now in the Budget.
   */
  confirm(payee: AccountId, typed?: string): boolean {
    const e = this.#entries.get(payee);
    if (!e || e.checking || !e.result) return false;
    const kind = e.result.verdict.verdict;
    if (confirmationFor(kind) === "type_id" && !typedIdMatches(payee, typed ?? "")) return false;
    e.acknowledged = kind;
    this.#settle();
    return e.added;
  }

  /** Reads the account again. The Payee is out of the Budget until the new verdict is in. */
  recheck(payee: AccountId): void {
    const e = this.#entries.get(payee);
    if (!e || e.checking) return;
    e.added = false;
    e.reading = null;
    e.result = null;
    e.problem = null;
    e.checking = true;
    e.started = false;
    this.#start(e);
    this.#settle();
  }

  #start(e: Entry): void {
    const reader = this.#reader;
    if (!reader) return;
    e.started = true;
    const run = ++e.run;
    const done = (reading: PayeeReading | null, problem: string | null) => {
      if (this.#entries.get(e.payee) !== e || e.run !== run) return;
      e.checking = false;
      e.reading = reading;
      e.problem = problem;
      this.#settle();
    };
    reader(e.payee).then(
      (reading) => done(reading, null),
      (err) => done(null, err instanceof PayeeCheckUnavailable ? err.message : new PayeeCheckUnavailable().message),
    );
  }

  /** Judges every Payee that is not added yet against the ones that are, and adds those whose verdict is covered. */
  #settle(): void {
    for (let changed = true; changed; ) {
      changed = false;
      const added = this.#order.filter((p) => this.#entries.get(p)?.added);
      for (const payee of this.#order) {
        const e = this.#entries.get(payee)!;
        if (e.added || e.checking || !e.reading) continue;
        const same = e.result !== null && e.result.against.length === added.length && e.result.against.every((p, i) => p === added[i]);
        if (!same) e.result = e.reading.judge(added);
        if (covers(e.acknowledged, e.result!.verdict.verdict)) {
          e.added = true;
          changed = true;
          break;
        }
      }
    }
    this.#rows = this.#order.map((payee): PayeeRow => {
      const e = this.#entries.get(payee)!;
      const need = e.result ? confirmationFor(e.result.verdict.verdict) : "none";
      const state: PayeeRowState = e.checking ? "checking" : !e.result ? "unavailable" : e.added ? "added" : need === "type_id" ? "needs_typed_id" : "needs_confirm";
      return { payee, state, result: e.result, acknowledged: e.acknowledged, problem: e.checking ? null : e.problem };
    });
    for (const l of this.#listeners) l();
  }
}
