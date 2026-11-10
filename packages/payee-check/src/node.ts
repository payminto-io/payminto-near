/**
 * File-backed stores, for Node only. Import from `@payminto/payee-check/node`; the main entry stays free of `node:` imports
 * so it runs in a browser.
 */
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { z } from "zod";
import type { AccountId } from "./account.ts";
import { StoreError, reportSchema, reportsAgainst, withReport, type Blocklist, type Report, type ReportInput } from "./blocklist.ts";
import { codeRecordSchema, type CodeStore } from "./code-store.ts";
import { nextCodeRecord, type CodeRecord } from "./facts.ts";

/** The file operations an atomic write needs. Tests replace one to simulate a crash between write and rename. */
export type AtomicIo = { rename: (from: string, to: string) => Promise<void> };

/**
 * Replaces a file's content so that a reader sees either all of the old content or all of the new, never a mix.
 * The content goes to a new file beside the target, is flushed to disk, and is renamed over the target. A failure at
 * any step leaves the target as it was and removes the partial file.
 */
export async function writeFileAtomic(path: string, data: string, io: AtomicIo = { rename }): Promise<void> {
  const partial = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(partial, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.rename(partial, path);
  } catch (e) {
    await rm(partial, { force: true });
    throw new StoreError("io", `could not write ${path}`, { cause: e });
  }
}

/**
 * One JSON document in one file. Reads validate the whole document, and a file that does not validate is an error, not
 * an empty store. Updates in this process run one at a time, each re-reading the file first. Two processes writing the
 * same file can still lose one update to the other: keep one writer per file.
 */
class JsonFile<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;
  readonly #empty: T;
  readonly #io: AtomicIo | undefined;
  #last: Promise<unknown> = Promise.resolve();

  constructor(path: string, schema: z.ZodType<T>, empty: T, io?: AtomicIo) {
    this.#path = path;
    this.#schema = schema;
    this.#empty = empty;
    this.#io = io;
  }

  async read(): Promise<T> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.#empty;
      throw new StoreError("io", `could not read ${this.#path}`, { cause: e });
    }
    let parsed: ReturnType<z.ZodType<T>["safeParse"]>;
    try {
      parsed = this.#schema.safeParse(JSON.parse(text));
    } catch {
      throw new StoreError("corrupt_store", `${this.#path} is not JSON`);
    }
    if (!parsed.success) throw new StoreError("corrupt_store", `${this.#path} does not hold a valid store`);
    return parsed.data;
  }

  /** Reads, applies `change`, and writes the result atomically. `change` may throw to abandon the update. */
  update<R>(change: (current: T) => { next: T; result: R }): Promise<R> {
    const run = this.#last.then(async () => {
      const { next, result } = change(await this.read());
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`, this.#io);
      return result;
    });
    this.#last = run.catch(() => {});
    return run;
  }
}

const blocklistFileSchema = z.strictObject({ version: z.literal(1), reports: z.array(reportSchema).max(100_000) });

/**
 * A blocklist in one JSON file, written atomically. Every report is validated when it is submitted and again every
 * time the file is read, so a file received from another party is held to the same rules as a single report.
 */
export class FileBlocklist implements Blocklist {
  readonly #file: JsonFile<z.infer<typeof blocklistFileSchema>>;
  readonly #clock: () => number;

  constructor(options: { path: string; clock?: () => number; io?: AtomicIo }) {
    this.#file = new JsonFile(options.path, blocklistFileSchema, { version: 1, reports: [] }, options.io);
    this.#clock = options.clock ?? Date.now;
  }

  report(input: ReportInput): Promise<Report> {
    return this.#file.update((current) => {
      const { reports, added } = withReport(current.reports, input, this.#clock());
      return { next: { version: 1, reports }, result: added };
    });
  }

  async reportsFor(account: AccountId): Promise<Report[]> {
    return reportsAgainst((await this.#file.read()).reports, account);
  }
}

const codeFileSchema = z.strictObject({ version: z.literal(1), accounts: z.record(z.string().max(64), codeRecordSchema) });

/** A code store in one JSON file, written atomically. */
export class FileCodeStore implements CodeStore {
  readonly #file: JsonFile<z.infer<typeof codeFileSchema>>;

  constructor(options: { path: string; io?: AtomicIo }) {
    this.#file = new JsonFile(options.path, codeFileSchema, { version: 1, accounts: {} }, options.io);
  }

  async get(account: AccountId): Promise<CodeRecord | null> {
    return (await this.#file.read()).accounts[account] ?? null;
  }

  observe(account: AccountId, contractId: string | null, nowMs: number): Promise<CodeRecord> {
    return this.#file.update((current) => {
      const record = nextCodeRecord(current.accounts[account] ?? null, contractId, nowMs);
      return { next: { version: 1, accounts: { ...current.accounts, [account]: record } }, result: record };
    });
  }
}
