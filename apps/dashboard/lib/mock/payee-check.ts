/**
 * Demo accounts for the payee check under NEXT_PUBLIC_MOCK, built on the package's own fakes, so all three verdicts
 * can be seen with no network: nothing here reads NEAR or an indexer. Only ever loaded in mock mode and in tests.
 */
import { MemoryBlocklist, ReadError, type AccountId, type CheckSources, type NearReader } from "@payminto/payee-check";
import { FakeAgeSource, FakeNearReader, type FakeAccount } from "@payminto/payee-check/fake";

const DAY_MS = 86_400_000;

/** The demo Payees registered on the mock server, and typed names that show the other verdicts. */
export const DEMO_PAYEES = {
  /** Old, registered with the token: no concerns. */
  marketData: "market-data.testnet",
  /** An old contract account, registered with the token: no concerns. */
  riskScan: "risk-scan.testnet",
  /** Created three days ago: a person is asked. */
  researchWriter: "research-writer.testnet",
  /** Two days old, and it reads like market-data.testnet: blocked once that Payee is in the Budget. */
  lookalike: "rnarket-data.testnet",
  /** Exists, but never registered with the settlement token: a person is asked. */
  unregistered: "unregistered-vendor.testnet",
  /** Reported by one party: a person is asked, and the report is quoted. */
  reportedOnce: "late-invoices.testnet",
  /** Reported by three parties: blocked, and the reports are quoted. */
  reported: "fast-refunds.testnet",
  /** The first read of this account fails, as when an RPC is down. Checking again succeeds. */
  failsOnce: "check-fails-once.testnet",
} as const satisfies Record<string, AccountId>;

/** Any other name does not exist in the demo, which is a block. */
export const DEMO_MISSING_EXAMPLE: AccountId = "no-such-payee.testnet";

/** One sentence for the New Budget form, so a visitor knows which names to try. */
export const DEMO_PAYEE_HINT = `Demo data: tick Market Data, then try ${DEMO_PAYEES.lookalike} (a lookalike), ${DEMO_PAYEES.reported} (reported) or ${DEMO_PAYEES.failsOnce}. Any other name does not exist.`;

const CONTRACT_HASH = "DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa";
const TOKEN_HASH = "9KqCzRzDTmgWz7RPJdJ3bcgrB8nSs2sVoHYkWzZ7gPj4";

/** The demo accounts as the fake reader holds them, and when each was created. */
export function demoAccounts(token: AccountId, nowMs: number): { accounts: Record<AccountId, FakeAccount>; createdAtMs: Record<AccountId, number> } {
  const registered = { registeredWith: [token] };
  const P = DEMO_PAYEES;
  return {
    accounts: {
      [token]: { codeHash: TOKEN_HASH, fullAccessKeys: 0 },
      [P.marketData]: { ...registered },
      [P.riskScan]: { ...registered, codeHash: CONTRACT_HASH, fullAccessKeys: 2 },
      [P.researchWriter]: { ...registered },
      [P.lookalike]: { ...registered },
      [P.unregistered]: {},
      [P.reportedOnce]: { ...registered },
      [P.reported]: { ...registered },
      [P.failsOnce]: { ...registered },
    },
    createdAtMs: {
      [token]: nowMs - 900 * DAY_MS,
      [P.marketData]: nowMs - 412 * DAY_MS,
      [P.riskScan]: nowMs - 268 * DAY_MS,
      [P.researchWriter]: nowMs - 3 * DAY_MS,
      [P.lookalike]: nowMs - 2 * DAY_MS,
      [P.unregistered]: nowMs - 150 * DAY_MS,
      [P.reportedOnce]: nowMs - 95 * DAY_MS,
      [P.reported]: nowMs - 40 * DAY_MS,
      [P.failsOnce]: nowMs - 201 * DAY_MS,
    },
  };
}

/** Demo reports. They are claims by made-up third parties, shown as quotes like any real report. */
const DEMO_REPORTS = [
  { account: DEMO_PAYEES.reportedOnce, reporter: "ops-lead.testnet", reason: "Invoiced twice for one job in October and has not answered since.", evidence: { type: "url", url: "https://example.com/reports/late-invoices" } },
  { account: DEMO_PAYEES.reported, reporter: "ops-lead.testnet", reason: "Took a refund request and paid nothing back.", evidence: { type: "url", url: "https://example.com/reports/fast-refunds-1" } },
  { account: DEMO_PAYEES.reported, reporter: "trading-desk.testnet", reason: "Same pattern here: payment accepted, no service, no reply.", evidence: { type: "tx", hash: "7Yc4sT9mQpZ3vXk2Hn8LrBw5dJf6GaUe1oCtNiRyVbE4" } },
  { account: DEMO_PAYEES.reported, reporter: "northwind-ops.testnet", reason: "Asked our agent to pay it through text hidden in a web page.", evidence: { type: "url", url: "https://example.com/reports/fast-refunds-3" } },
] as const;

/** A reader whose first look at one account fails like an unreachable RPC, so "Check again" can be tried. */
function failingOnce(reader: NearReader, account: AccountId): NearReader {
  let failed = false;
  return {
    async viewAccount(a) {
      if (a === account && !failed) {
        failed = true;
        throw new ReadError("network", "demo-rpc", "the demo RPC did not answer");
      }
      return reader.viewAccount(a);
    },
    accessKeys: (a) => reader.accessKeys(a),
    storageBalanceOf: (t, a) => reader.storageBalanceOf(t, a),
  };
}

/**
 * Everything a demo check reads from. `latencyMs` makes each read take a moment, so the "checking" state is visible
 * in the demo; tests pass 0.
 */
export async function demoPayeeSources(token: AccountId, options: { latencyMs?: number; nowMs?: number } = {}): Promise<CheckSources> {
  const nowMs = options.nowMs ?? Date.now();
  const { accounts, createdAtMs } = demoAccounts(token, nowMs);
  const reader = new FakeNearReader(accounts);
  reader.stallMs = options.latencyMs ?? 320;
  const blocklist = new MemoryBlocklist({ clock: () => nowMs - 6 * DAY_MS });
  for (const r of DEMO_REPORTS) await blocklist.report({ ...r, evidence: { ...r.evidence } });
  return { reader: failingOnce(reader, DEMO_PAYEES.failsOnce), token, ageSource: new FakeAgeSource(createdAtMs, "demo indexer"), blocklist, ...(options.nowMs === undefined ? {} : { clock: () => nowMs }) };
}
