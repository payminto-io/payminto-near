import { z } from "zod";
import {
  acceptanceInTime,
  acceptanceSignedFor,
  claimOf,
  compareAscii,
  settleDeadline,
  settleOwnTx,
  verifyDigest,
  voucherDigest,
  voucherFieldsShape,
  voucherOf,
  voucherSignedBy,
  zAccountId,
  zAtomic,
  zId32,
  zNetwork,
  zPublicKey,
  zSig64,
  type Acceptance,
  type AccountId,
  type Chain,
  type Claim,
  type Id32,
  type Network,
  type PublicKey,
  type Sig64,
  type VoucherFields,
  type WalletTx,
} from "@payminto/protocol";

/**
 * Seller side of spec decision 4: `settle_own` is never cut. A seller keeps the latest voucher the node accepted for
 * each (Budget, payee), together with the node's acceptance of it, so it can settle its own earnings on the hub with
 * `settle_own` even if the node is gone. Vouchers are cumulative, so the latest one carries every earlier call to that
 * payee.
 *
 * The hub settles a voucher through `settle_own` only with the acceptance the node signed for that exact call. A
 * voucher with no acceptance cannot be settled by the seller, and only the node that accepted the call can sign one.
 */

/** The node's acceptance as kept in a file or an export: the receipt key, Unix seconds as a decimal string, and the signature. */
export type StoredAcceptance = { nodeKey: PublicKey; timestampS: string; signature: Sig64 };

export type StoredVoucher = VoucherFields & {
  hub: AccountId;
  network: Network;
  /** The node's call id for this voucher. */
  callId: Id32;
  /** ISO time the node accepted it. */
  acceptedAt: string;
  /**
   * The node's signed acceptance of this voucher, from the receipt. `settle_own` needs it. Null only for a voucher read
   * from a file or export written before acceptances were kept: such a voucher cannot be settled by the seller.
   */
  acceptance: StoredAcceptance | null;
};

/** Why a voucher with no acceptance is of no use for `settle_own`. Shown wherever one turns up. */
export const NO_ACCEPTANCE =
  "the node's acceptance of this voucher is missing; settle_own needs it, and only the node that accepted the call can sign it";

export interface VoucherStore {
  /**
   * Keeps `v` when its cumulative is above the stored one for its (hub, network, Budget, payee); never lowers it.
   * Durable when it returns. Returns whether `v` became the latest. Throws for a voucher with no acceptance.
   */
  put(v: StoredVoucher): boolean;
  latest(hub: AccountId, network: Network, budgetId: Id32, payee: AccountId): StoredVoucher | undefined;
  all(): StoredVoucher[];
  close?(): void;
}

const U64_MAX = 2n ** 64n - 1n;
const storedAcceptanceSchema = z
  .strictObject({ nodeKey: zPublicKey, timestampS: zAtomic, signature: zSig64 })
  .refine((a) => BigInt(a.timestampS) <= U64_MAX, { message: "timestampS must fit in 64 bits", path: ["timestampS"] });

const storedVoucherSchema = z
  .strictObject({
    ...voucherFieldsShape,
    hub: zAccountId,
    network: zNetwork,
    callId: zId32,
    acceptedAt: z.string().min(1).max(64),
    // Absent in files and exports written before acceptances were kept.
    acceptance: storedAcceptanceSchema.nullable().default(null),
  })
  .refine((v) => BigInt(v.cumulative) >= BigInt(v.amount), { message: "cumulative must be at least amount", path: ["cumulative"] });

const keyOf = (v: Pick<StoredVoucher, "hub" | "network" | "budgetId" | "payee">) => `${v.hub}|${v.network}|${v.budgetId}|${v.payee}`;

const ordered = (vs: Iterable<StoredVoucher>) =>
  [...vs].sort((a, b) => compareAscii(a.hub, b.hub) || compareAscii(a.network, b.network) || compareAscii(a.budgetId, b.budgetId) || compareAscii(a.payee, b.payee));

const copy = (v: StoredVoucher): StoredVoucher => ({ ...v, acceptance: v.acceptance ? { ...v.acceptance } : null });

/** The acceptance in the form the hub takes it. */
export const acceptanceOf = (a: StoredAcceptance): Acceptance => ({ nodeKey: a.nodeKey, timestampS: BigInt(a.timestampS), signature: a.signature });

/** True when the stored acceptance is the node key's signature over exactly this voucher. It does not prove the key is registered on the hub. */
export function acceptanceCovers(v: StoredVoucher): boolean {
  return v.acceptance !== null && acceptanceSignedFor(claimOf(v), acceptanceOf(v.acceptance));
}

/** In-process store: lost on restart. Use FileVoucherStore for anything that earns real money. */
export class MemoryVoucherStore implements VoucherStore {
  protected readonly latestByKey = new Map<string, StoredVoucher>();

  put(v: StoredVoucher): boolean {
    if (v.acceptance === null) throw new Error(`voucher ${v.callId} was not stored: ${NO_ACCEPTANCE}`);
    return this.merge(v);
  }

  /** Keeps `v` if it is above what is stored. Also takes vouchers with no acceptance, which only an old file holds. */
  protected merge(v: StoredVoucher): boolean {
    const k = keyOf(v);
    const prev = this.latestByKey.get(k);
    if (prev && BigInt(prev.cumulative) >= BigInt(v.cumulative)) return false;
    this.latestByKey.set(k, copy(v));
    return true;
  }

  latest(hub: AccountId, network: Network, budgetId: Id32, payee: AccountId): StoredVoucher | undefined {
    const v = this.latestByKey.get(keyOf({ hub, network, budgetId, payee }));
    return v ? copy(v) : undefined;
  }

  all(): StoredVoucher[] {
    return ordered(this.latestByKey.values()).map(copy);
  }
}

/** Written by this version. `v1` files, which hold no acceptances, are still read. */
const FILE_FORMAT = "payminto.voucher-store.v2";
const fileSchema = z.object({ format: z.enum(["payminto.voucher-store.v1", FILE_FORMAT]), vouchers: z.array(storedVoucherSchema) });

type Fs = typeof import("node:fs");
type Path = typeof import("node:path");
type Crypto = typeof import("node:crypto");

function builtins(): { fs: Fs; path: Path; crypto: Crypto } {
  // Node built-ins load at runtime, so the SDK still imports in a browser or edge runtime.
  const builtin = typeof process !== "undefined" ? process.getBuiltinModule : undefined;
  if (!builtin) throw new Error("FileVoucherStore needs Node.js");
  return { fs: builtin("node:fs") as Fs, path: builtin("node:path") as Path, crypto: builtin("node:crypto") as Crypto };
}

export type FileVoucherStoreOptions = {
  /** A lock file untouched for this long belongs to a writer that died mid-write, and is taken over. Default 10 000 ms. */
  lockStaleMs?: number;
  /** How long a write waits for the lock before it gives up. Default 15 000 ms, longer than `lockStaleMs`. */
  lockWaitMs?: number;
};

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

type LockFile = { token: string; mtimeMs: number };

/** Blocks this thread for `ms`. `put` is synchronous, and a contended lock is held for a few milliseconds. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A crash-safe JSON file of the latest voucher per (hub, network, Budget, payee), safe for several writers.
 *
 * - Every `put` that raises a cumulative writes the whole file to a temporary sibling, fsyncs it, renames it over the
 *   old file and fsyncs the directory, so a crash leaves either the old or the new file, never a torn one.
 * - Several processes may share one file, for example two containers on one volume. Each write takes `<path>.lock`,
 *   an exclusive lock file created with `O_EXCL` that holds a random owner token, then reads the file again and merges
 *   it with what it knows before it rewrites it. So no writer drops a voucher another writer stored.
 * - The lock is held only for one write. Who holds it is decided by the token, never by a process id: two containers
 *   often both run as pid 1. A lock file left by a writer that died is taken over once it is `lockStaleMs` old, by an
 *   atomic rename that only one of several waiting writers can win.
 * - A file that does not parse is never overwritten: opening it or writing to it throws, so the vouchers in it can
 *   still be recovered.
 */
export class FileVoucherStore extends MemoryVoucherStore {
  readonly path: string;
  readonly #fs: Fs;
  readonly #nodePath: Path;
  readonly #crypto: Crypto;
  readonly #lock: string;
  readonly #staleMs: number;
  readonly #waitMs: number;
  /** Identity of the file as last read, so `all` and `latest` re-read only when another writer changed it. */
  #seen = "";
  #closed = false;

  constructor(path: string, o: FileVoucherStoreOptions = {}) {
    super();
    const { fs, path: nodePath, crypto } = builtins();
    this.#fs = fs;
    this.#nodePath = nodePath;
    this.#crypto = crypto;
    this.path = nodePath.resolve(path);
    this.#lock = `${this.path}.lock`;
    this.#staleMs = o.lockStaleMs ?? LOCK_STALE_MS;
    this.#waitMs = o.lockWaitMs ?? LOCK_WAIT_MS;
    if (this.#waitMs <= this.#staleMs) throw new Error("lockWaitMs must be longer than lockStaleMs, or a dead writer's lock could never be taken over");
    fs.mkdirSync(nodePath.dirname(this.path), { recursive: true, mode: 0o700 });
    this.#locked(() => {
      this.#readAndMerge();
      // Under the lock no other writer is mid-write, so any temporary sibling here was left by a crash. The small
      // files the lock itself uses are removed only once they are old, as another writer may be using one right now.
      const dir = nodePath.dirname(this.path);
      const now = this.#fsNowMs();
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(`${nodePath.basename(this.path)}.`)) continue;
        const file = nodePath.join(dir, f);
        if (f.endsWith(".tmp")) fs.rmSync(file, { force: true });
        else if (f.endsWith(".aside") || f.endsWith(".probe")) {
          try {
            if (now - fs.statSync(file).mtimeMs > this.#staleMs) fs.rmSync(file, { force: true });
          } catch {
            // gone already
          }
        }
      }
    });
  }

  override put(v: StoredVoucher): boolean {
    if (this.#closed) throw new Error(`voucher store ${this.path} is closed`);
    const parsed = storedVoucherSchema.parse(v);
    if (parsed.acceptance === null) throw new Error(`voucher ${parsed.callId} was not stored: ${NO_ACCEPTANCE}`);
    return this.#locked((holdsLock) => {
      // Another writer may have stored vouchers since this process last looked: read them before rewriting.
      this.#readAndMerge();
      if (!this.merge(parsed)) return false;
      this.#write(super.all(), holdsLock);
      return true;
    });
  }

  /** The latest voucher on disk, including what other writers stored. */
  override latest(hub: AccountId, network: Network, budgetId: Id32, payee: AccountId): StoredVoucher | undefined {
    this.#refresh();
    return super.latest(hub, network, budgetId, payee);
  }

  /** Every voucher on disk, including what other writers stored. */
  override all(): StoredVoucher[] {
    this.#refresh();
    return super.all();
  }

  close(): void {
    this.#closed = true;
  }

  // ---- the file ----

  /** Re-reads the file when another writer replaced it. A rename is atomic, so a reader never sees a torn file. */
  #refresh(): void {
    if (this.#closed) return;
    if (this.#identity() !== this.#seen) this.#readAndMerge();
  }

  #identity(): string {
    try {
      const s = this.#fs.statSync(this.path);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "";
    }
  }

  #readAndMerge(): void {
    const fs = this.#fs;
    const identity = this.#identity();
    if (identity === "") return;
    let parsed: z.infer<typeof fileSchema>;
    try {
      parsed = fileSchema.parse(JSON.parse(fs.readFileSync(this.path, "utf8")));
    } catch (err) {
      throw new Error(`${this.path} is not a readable voucher store (${err instanceof Error ? err.message : String(err)}); it was left untouched`);
    }
    for (const v of parsed.vouchers) this.merge(v);
    this.#seen = identity;
  }

  #write(vouchers: StoredVoucher[], holdsLock: () => boolean): void {
    const fs = this.#fs;
    const tmp = `${this.path}.${this.#crypto.randomBytes(8).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify({ format: FILE_FORMAT, vouchers }, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!holdsLock()) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`voucher store ${this.path}: this write took longer than ${this.#staleMs} ms and another writer took over the lock; nothing was written`);
    }
    fs.renameSync(tmp, this.path);
    this.#seen = this.#identity();
    // Make the rename itself durable. Some platforms cannot fsync a directory; the rename is still atomic there.
    try {
      const dir = fs.openSync(this.#nodePath.dirname(this.path), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } catch {
      // best effort
    }
  }

  // ---- the lock ----

  /** Runs `work` while holding the exclusive lock. `holdsLock` tells `work` whether the lock is still this writer's. */
  #locked<T>(work: (holdsLock: () => boolean) => T): T {
    const token = this.#acquire();
    try {
      return work(() => this.#readLock()?.token === token);
    } finally {
      this.#release(token);
    }
  }

  #readLock(): LockFile | null {
    try {
      const mtimeMs = this.#fs.statSync(this.#lock).mtimeMs;
      // The whole content is the identity: a lock written by an older version holds a pid, which is compared as text.
      return { token: this.#fs.readFileSync(this.#lock, "utf8"), mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * Moves the lock file aside if, and only if, it still holds `token`. The rename is atomic, so of several callers one
   * moves it. A caller that moved a lock with another token took a live writer's lock, and puts it back unless a third
   * writer has taken the path meanwhile; that writer notices in `holdsLock` before it replaces the voucher file.
   */
  #removeLockIf(token: string): boolean {
    const fs = this.#fs;
    const aside = `${this.#lock}.${this.#crypto.randomBytes(8).toString("hex")}.aside`;
    try {
      fs.renameSync(this.#lock, aside);
    } catch {
      return false; // already gone, or taken by someone else
    }
    let found: string | null = null;
    try {
      found = fs.readFileSync(aside, "utf8");
    } catch {
      // unreadable: treat as not ours
    }
    if (found !== token) {
      try {
        fs.linkSync(aside, this.#lock);
      } catch {
        // the path is taken again; the lock's former holder checks `holdsLock` before it writes
      }
    }
    fs.rmSync(aside, { force: true });
    return found === token;
  }

  /**
   * The time by the filesystem's own clock: the modification time of a file written just now. A lock's age is judged
   * against this, so it does not depend on this host's clock agreeing with the clock that stamped the lock.
   */
  #fsNowMs(): number {
    const fs = this.#fs;
    const probe = `${this.#lock}.${this.#crypto.randomBytes(8).toString("hex")}.probe`;
    try {
      fs.writeFileSync(probe, "", { mode: 0o600 });
      return fs.statSync(probe).mtimeMs;
    } catch {
      return Date.now();
    } finally {
      fs.rmSync(probe, { force: true });
    }
  }

  #acquire(): string {
    const fs = this.#fs;
    const token = JSON.stringify({ token: this.#crypto.randomBytes(16).toString("hex"), pid: process.pid, at: new Date().toISOString() });
    const deadline = Date.now() + this.#waitMs;
    let holder: LockFile | null = null;
    for (;;) {
      try {
        const fd = fs.openSync(this.#lock, "wx", 0o600);
        try {
          fs.writeSync(fd, token);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      holder = this.#readLock();
      if (holder !== null && this.#fsNowMs() - holder.mtimeMs > this.#staleMs) {
        // Its writer died mid-write. Only one waiting writer wins this rename; the others find the path free or taken.
        this.#removeLockIf(holder.token);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`voucher store ${this.path} is locked by another writer (${holder?.token.slice(0, 120) ?? "unknown"}) and did not come free in ${this.#waitMs} ms`);
      }
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }

  #release(token: string): void {
    this.#removeLockIf(token);
  }
}

// ------------------------------------------------------------------------------------------------- export

export const VOUCHER_EXPORT_FORMAT = "payminto.vouchers.v2";

/** What a seller hands its own wallet to call `settle_own`: the latest voucher per Budget for one hub, each with the node's acceptance. */
export type VoucherExport = { format: typeof VOUCHER_EXPORT_FORMAT; hub: AccountId; network: Network; exportedAt: string; vouchers: StoredVoucher[] };

/**
 * A parsed export, with how far it was checked:
 * - `"hub"`: each voucher was signed by its Budget's agent key as the hub holds it, and each acceptance by a receipt
 *   key the Budget's settler registered on the hub. This is what `settle_own` itself checks.
 * - `"declared-keys"`: each signature verifies only against the key the export itself names. Anyone can write such an
 *   export with a key of their own; it says nothing about what the hub will accept. Pass a chain reader to do better.
 */
export type ParsedVoucherExport = VoucherExport & { checkedAgainst: "hub" | "declared-keys" };

const exportSchema = z.object({
  // `v1` exports hold no acceptances. They still parse, and every voucher in them is reported as not settleable.
  format: z.enum(["payminto.vouchers.v1", VOUCHER_EXPORT_FORMAT]),
  hub: zAccountId,
  network: zNetwork,
  exportedAt: z.string(),
  vouchers: z.array(storedVoucherSchema),
});

/** The latest vouchers for one hub, optionally for one payee account only. */
export function exportVouchers(store: Pick<VoucherStore, "all">, o: { hub: AccountId; network: Network; payee?: AccountId; now?: Date }): VoucherExport {
  return {
    format: VOUCHER_EXPORT_FORMAT,
    hub: o.hub,
    network: o.network,
    exportedAt: (o.now ?? new Date()).toISOString(),
    vouchers: store.all().filter((v) => v.hub === o.hub && v.network === o.network && (o.payee === undefined || v.payee === o.payee)),
  };
}

/**
 * Parses an export and checks every voucher signature and every acceptance. Throws on anything malformed or forged.
 *
 * With `chain`, a reader of the hub the export names, each voucher is checked against its Budget's agent key from the
 * hub, and each acceptance against the receipt keys of the Budget's settler: the result says `checkedAgainst: "hub"`.
 * Without it the signatures are checked only against the keys the export declares, which proves nothing about the
 * hub, and the result says `checkedAgainst: "declared-keys"`.
 * A voucher with no acceptance parses; `settleOwnClaims` lists it as not settleable.
 */
export async function parseVoucherExport(json: unknown, chain?: Pick<Chain, "hub" | "network" | "budget" | "receiptKeys">): Promise<ParsedVoucherExport> {
  const e = exportSchema.parse(json);
  if (chain && (chain.hub !== e.hub || chain.network !== e.network)) {
    throw new Error(`the export is for ${e.hub} on ${e.network}, but the chain reader is for ${chain.hub} on ${chain.network}`);
  }
  const receiptKeys = new Map<AccountId, PublicKey[]>();
  for (const v of e.vouchers) {
    if (v.hub !== e.hub || v.network !== e.network) throw new Error(`voucher ${v.callId} is for ${v.hub} on ${v.network}, not ${e.hub} on ${e.network}`);
    if (!voucherSignedBy(e.hub, e.network, v)) throw new Error(`voucher ${v.callId} does not carry a valid signature by ${v.publicKey}`);
    if (v.acceptance !== null && !acceptanceCovers(v)) {
      throw new Error(`voucher ${v.callId} carries an acceptance that is not a valid signature by ${v.acceptance.nodeKey} over this voucher`);
    }
    if (!chain) continue;
    const budget = await chain.budget(v.budgetId);
    if (!budget) throw new Error(`voucher ${v.callId} names Budget ${v.budgetId}, which ${e.hub} does not hold`);
    if (!verifyDigest(budget.agentPk, voucherDigest(e.hub, e.network, voucherOf(v)), v.signature)) {
      throw new Error(`voucher ${v.callId} is signed by ${v.publicKey}, not by ${budget.agentPk}, the agent key of Budget ${v.budgetId} on the hub`);
    }
    if (v.acceptance !== null) {
      let keys = receiptKeys.get(budget.settler);
      if (!keys) receiptKeys.set(budget.settler, (keys = await chain.receiptKeys(budget.settler)));
      if (!keys.includes(v.acceptance.nodeKey)) {
        throw new Error(`voucher ${v.callId} carries an acceptance by ${v.acceptance.nodeKey}, which is not a receipt key that ${budget.settler}, the settler of Budget ${v.budgetId}, registered on the hub`);
      }
    }
  }
  return { ...e, format: VOUCHER_EXPORT_FORMAT, checkedAgainst: chain ? "hub" : "declared-keys" };
}

/** A claim with the node's acceptance of it: everything `settle_own` takes. */
export type SettleOwnClaim = { claim: Claim; acceptance: Acceptance };

/** A voucher the seller holds but cannot settle by itself, and why. */
export type Unsettleable = { voucher: StoredVoucher; reason: string };

export type SettleOwnPlan = {
  /** What `payee` can settle with `settle_own` now. */
  claims: SettleOwnClaim[];
  /** Vouchers for `payee` that hold unsettled calls but that the hub would refuse, each with the reason. */
  unsettleable: Unsettleable[];
};

/**
 * The claims `payee` can still settle itself: its latest voucher per Budget with the node's acceptance, skipping any
 * the hub has already settled as far (`settledOf`). A stale claim would only be refused with STALE_VOUCHER.
 *
 * A voucher with no acceptance cannot be settled this way and is returned in `unsettleable` with the reason. Given a
 * reader with `budget`, the plan also leaves out what the hub would refuse: a closed Budget, a payee that is the
 * Budget's owner, and an acceptance dated after the Budget's revoke or expiry.
 */
export async function settleOwnClaims(
  exp: VoucherExport,
  payee: AccountId,
  chain?: Pick<Chain, "settledOf"> & Partial<Pick<Chain, "budget">>,
  o: { nowMs?: bigint } = {},
): Promise<SettleOwnPlan> {
  const plan: SettleOwnPlan = { claims: [], unsettleable: [] };
  for (const v of exp.vouchers) {
    if (v.payee !== payee) continue;
    const claim = claimOf(v);
    if (chain && (await chain.settledOf(v.budgetId, v.payee)) >= claim.cumulative) continue;
    const refuse = (reason: string) => plan.unsettleable.push({ voucher: v, reason });
    if (v.acceptance === null) {
      refuse(NO_ACCEPTANCE);
      continue;
    }
    const acceptance = acceptanceOf(v.acceptance);
    if (chain?.budget) {
      const budget = await chain.budget(v.budgetId);
      if (!budget) {
        refuse(`the hub holds no Budget ${v.budgetId}`);
        continue;
      }
      if (budget.owner === payee) {
        refuse("the payee is the Budget's owner, and settle_own never pays a Budget's owner");
        continue;
      }
      if (!acceptanceInTime(acceptance, budget)) {
        refuse(`the node accepted this call at ${v.acceptedAt}, after the Budget was revoked or expired; only the node's own batch can settle it`);
        continue;
      }
      if ((o.nowMs ?? BigInt(Date.now())) > settleDeadline(budget)) {
        refuse("the Budget's settlement period is over");
        continue;
      }
    }
    plan.claims.push({ claim, acceptance });
  }
  return plan;
}

/**
 * One `settle_own` wallet transaction per claim, for the payee's own wallet to sign. `storageDeposit` is yoctoNEAR
 * attached to each: the hub takes only what new storage costs once the Budget's prepaid reserve is used up, and
 * refunds the rest.
 */
export const settleOwnTxs = (hub: AccountId, claims: readonly SettleOwnClaim[], storageDeposit = "0"): WalletTx[] =>
  claims.map((c) => settleOwnTx(hub, c.claim, c.acceptance, storageDeposit));
