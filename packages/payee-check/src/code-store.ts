import { z } from "zod";
import type { AccountId } from "./account.ts";
import { nextCodeRecord, type CodeRecord } from "./facts.ts";

/**
 * Remembers the code each account ran when it was last checked, so a later check can say that it changed.
 * NEAR RPC reports the code an account runs now, not when it was deployed, so a change is only ever seen between two checks.
 */
export interface CodeStore {
  get(account: AccountId): Promise<CodeRecord | null>;
  /** Records what the account runs now and returns the updated record. */
  observe(account: AccountId, contractId: string | null, nowMs: number): Promise<CodeRecord>;
}

export const codeRecordSchema = z.strictObject({
  contractId: z.string().max(200).nullable(),
  firstSeenAtMs: z.number().int().nonnegative(),
  changedAtMs: z.number().int().nonnegative().nullable(),
  previousContractId: z.string().max(200).nullable(),
});

/** A code store held in memory. For tests, demos and single-process use. */
export class MemoryCodeStore implements CodeStore {
  readonly #records = new Map<AccountId, CodeRecord>();

  async get(account: AccountId): Promise<CodeRecord | null> {
    return this.#records.get(account) ?? null;
  }

  async observe(account: AccountId, contractId: string | null, nowMs: number): Promise<CodeRecord> {
    const next = nextCodeRecord(this.#records.get(account) ?? null, contractId, nowMs);
    this.#records.set(account, next);
    return next;
  }
}
