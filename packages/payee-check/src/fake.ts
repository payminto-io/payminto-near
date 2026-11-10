/**
 * In-memory stand-ins for every source, for tests and for the attack demo. Nothing here touches the network.
 */
import type { AccountId } from "./account.ts";
import type { AgeSource } from "./age.ts";
import type { HistorySource } from "./check.ts";
import { NO_CONTRACT_HASH, type AccountView, type AgeAnswer } from "./facts.ts";
import { ReadError } from "./http.ts";
import type { AccessKey, AccessKeyList, NearReader, StorageBalance } from "./rpc.ts";

export type FakeAccount = {
  /** Base58 code hash. Omit for an account with no contract. */
  codeHash?: string;
  globalContractHash?: string;
  globalContractAccountId?: AccountId;
  /** Default 1. */
  fullAccessKeys?: number;
  /** Default 0. */
  functionCallKeys?: number;
  /** Tokens the account is registered with. */
  registeredWith?: AccountId[];
};

/** A `NearReader` over a map of accounts. `failWith` makes every read throw, and `stallMs` makes every read slow. */
export class FakeNearReader implements NearReader {
  readonly accounts = new Map<AccountId, FakeAccount>();
  /** When set, every read throws it. */
  failWith: Error | null = null;
  /** Every read waits this long first. */
  stallMs = 0;
  /** Every read made, in order, as `method:account`. */
  readonly calls: string[] = [];

  constructor(accounts: Record<AccountId, FakeAccount> = {}) {
    for (const [id, a] of Object.entries(accounts)) this.accounts.set(id, a);
  }

  set(account: AccountId, state: FakeAccount): this {
    this.accounts.set(account, state);
    return this;
  }

  async #enter(call: string): Promise<void> {
    this.calls.push(call);
    if (this.stallMs > 0) await new Promise((r) => setTimeout(r, this.stallMs));
    if (this.failWith) throw this.failWith;
  }

  async viewAccount(account: AccountId): Promise<AccountView | null> {
    await this.#enter(`viewAccount:${account}`);
    const a = this.accounts.get(account);
    if (!a) return null;
    return {
      amount: "1000000000000000000000000",
      locked: "0",
      codeHash: a.codeHash ?? NO_CONTRACT_HASH,
      storageUsage: 182,
      globalContractHash: a.globalContractHash ?? null,
      globalContractAccountId: a.globalContractAccountId ?? null,
      blockHeight: 1,
      blockHash: "11111111111111111111111111111111",
    };
  }

  async accessKeys(account: AccountId): Promise<AccessKeyList> {
    await this.#enter(`accessKeys:${account}`);
    const a = this.accounts.get(account);
    if (!a) return { keys: [], more: false };
    const full = Array.from({ length: a.fullAccessKeys ?? 1 }, (_, i): AccessKey => ({ publicKey: `ed25519:full${i}`, permission: "full_access", receiverId: null }));
    const call = Array.from({ length: a.functionCallKeys ?? 0 }, (_, i): AccessKey => ({ publicKey: `ed25519:call${i}`, permission: "function_call", receiverId: account }));
    return { keys: [...full, ...call], more: false };
  }

  async storageBalanceOf(token: AccountId, account: AccountId): Promise<StorageBalance | null> {
    await this.#enter(`storageBalanceOf:${token}:${account}`);
    if (!this.accounts.get(token)?.codeHash) throw new ReadError("no_contract", "fake-rpc", "the account has no contract");
    return this.accounts.get(account)?.registeredWith?.includes(token) ? { total: "1250000000000000000000", available: "0" } : null;
  }
}

/** An age source over a map. An account that is not in the map is `not_indexed`. */
export class FakeAgeSource implements AgeSource {
  readonly name: string;
  readonly answers = new Map<AccountId, AgeAnswer>();
  failWith: Error | null = null;

  constructor(createdAtMs: Record<AccountId, number | "no_record"> = {}, name = "fake-indexer") {
    this.name = name;
    for (const [id, at] of Object.entries(createdAtMs)) this.answers.set(id, at === "no_record" ? { status: "no_record" } : { status: "known", createdAtMs: at, txHash: null });
  }

  async createdAt(account: AccountId): Promise<AgeAnswer> {
    if (this.failWith) throw this.failWith;
    return this.answers.get(account) ?? { status: "not_indexed" };
  }
}

/** A history source that is told about payments as they happen. */
export class MemoryHistory implements HistorySource {
  readonly #paid = new Map<string, { count: number; total: bigint; lastAtMs: number | null }>();

  record(payer: AccountId, payee: AccountId, amount: bigint, atMs: number): void {
    const key = `${payer}>${payee}`;
    const h = this.#paid.get(key) ?? { count: 0, total: 0n, lastAtMs: null };
    this.#paid.set(key, { count: h.count + 1, total: h.total + amount, lastAtMs: atMs });
  }

  async paymentsBetween(payer: AccountId, payee: AccountId): Promise<{ count: number; total: bigint; lastAtMs: number | null }> {
    return this.#paid.get(`${payer}>${payee}`) ?? { count: 0, total: 0n, lastAtMs: null };
  }
}
