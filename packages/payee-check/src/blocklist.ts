import { z } from "zod";
import { isAccountId, type AccountId } from "./account.ts";

/** Hard caps on what a report may hold. Reports come from other parties, so every field is bounded. */
export const REPORT_LIMITS = {
  /** Characters in the free-text reason. */
  reasonMax: 280,
  /** Characters in an evidence URL. */
  urlMax: 300,
  /** Reports kept per reported account. One reporter holds one of them. */
  perAccount: 200,
} as const;

// Control characters, line and paragraph separators, and the bidirectional overrides used to disguise text.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
// A NEAR transaction hash: base58 of 32 bytes.
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function isPlainHttpsUrl(v: string): boolean {
  if (/\s/.test(v) || UNSAFE_TEXT.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

const zAccount = z.string().refine(isAccountId, "must be a NEAR account id");

const zEvidence = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("tx"), hash: z.string().regex(TX_HASH, "must be a NEAR transaction hash") }),
  z.strictObject({ type: z.literal("url"), url: z.string().max(REPORT_LIMITS.urlMax).refine(isPlainHttpsUrl, "must be an https URL without credentials") }),
]);

const zReason = z
  .string()
  .min(1)
  .max(REPORT_LIMITS.reasonMax)
  .refine((s) => !UNSAFE_TEXT.test(s), "must be one line of plain text")
  .refine((s) => s.trim() === s, "must not start or end with whitespace");

/** What a reporter submits. The store adds the time. */
export const reportInputSchema = z.strictObject({
  /** The account being reported. */
  account: zAccount,
  /** Who reports. The caller must have authenticated this account; the store does not. */
  reporter: zAccount,
  /** One line of plain text. It is a claim by the reporter, shown to people as a quote and never acted on. */
  reason: zReason,
  /** A transaction hash or an https URL that backs the claim. This package never fetches it. */
  evidence: zEvidence,
});

export const reportSchema = reportInputSchema.extend({
  /** Unix milliseconds at which the store accepted the report. */
  atMs: z.number().int().nonnegative(),
});

export type Evidence = z.infer<typeof zEvidence>;
export type ReportInput = z.infer<typeof reportInputSchema>;
export type Report = z.infer<typeof reportSchema>;

export type StoreErrorCode = "invalid_report" | "account_full" | "corrupt_store" | "io";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreError";
    this.code = code;
  }
}

/** The read side, which is all a check needs. */
export interface BlocklistReader {
  /** Reports against one account, oldest first. */
  reportsFor(account: AccountId): Promise<Report[]>;
}

/** A shared list of reported accounts. */
export interface Blocklist extends BlocklistReader {
  /**
   * Validates and stores one report, and returns it with its time.
   * A reporter holds one report per account: reporting again replaces the earlier one, so repeating a claim adds no weight.
   * Throws `StoreError` with code `invalid_report` or `account_full`.
   */
  report(input: ReportInput): Promise<Report>;
}

const byTimeThenReporter = (a: Report, b: Report): number => a.atMs - b.atMs || (a.reporter < b.reporter ? -1 : a.reporter > b.reporter ? 1 : 0);

/** Parses untrusted input into a report input, or throws `StoreError("invalid_report")` naming the bad fields only. */
export function parseReportInput(input: unknown): ReportInput {
  const r = reportInputSchema.safeParse(input);
  if (r.success) return r.data;
  // The message names fields and rules. It never echoes the submitted text.
  const fields = r.error.issues.map((i) => `${i.path.join(".") || "report"}: ${i.message}`);
  throw new StoreError("invalid_report", `invalid report (${fields.join("; ")})`);
}

/** The list after one report is added. Pure, and shared by every store. */
export function withReport(all: readonly Report[], input: unknown, nowMs: number): { reports: Report[]; added: Report } {
  const added: Report = { ...parseReportInput(input), atMs: nowMs };
  const others = all.filter((r) => !(r.account === added.account && r.reporter === added.reporter));
  if (others.filter((r) => r.account === added.account).length >= REPORT_LIMITS.perAccount) {
    throw new StoreError("account_full", `${added.account} already has ${REPORT_LIMITS.perAccount} reports`);
  }
  return { reports: [...others, added], added };
}

export function reportsAgainst(all: readonly Report[], account: AccountId): Report[] {
  return all.filter((r) => r.account === account).sort(byTimeThenReporter);
}

/** Reporters behind a set of reports, sorted, each counted once. */
export function distinctReporters(reports: readonly Report[]): AccountId[] {
  return [...new Set(reports.map((r) => r.reporter))].sort();
}

/** A blocklist held in memory. For tests, demos and single-process use. */
export class MemoryBlocklist implements Blocklist {
  #reports: Report[] = [];
  readonly #clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  async report(input: ReportInput): Promise<Report> {
    const next = withReport(this.#reports, input, this.#clock());
    this.#reports = next.reports;
    return next.added;
  }

  async reportsFor(account: AccountId): Promise<Report[]> {
    return reportsAgainst(this.#reports, account);
  }
}
