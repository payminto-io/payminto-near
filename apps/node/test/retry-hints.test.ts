/**
 * Retry hints of the rolling limits against a controlled clock: the node reads its own call log and answers with the
 * real seconds until the refused call fits, never a fixed window and never "never" when waiting works.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeChain } from "@payminto/chain/fake";
import { REPEAT_WINDOW_SEC, canonicalPolicy, keypairFromSeed, sha256Text, type AccountId, type Policy, type RetryHint } from "@payminto/protocol";
import { ChainClient } from "../src/chain.ts";
import { Database } from "../src/db/database.ts";
import { EventBus } from "../src/events.ts";
import { FundsTracker } from "../src/funds.ts";
import { Ledger } from "../src/ledger.ts";
import { silentLogger } from "../src/logger.ts";
import { Store, type ProviderRow } from "../src/store.ts";
import { VoucherService } from "../src/vouchers.ts";
import { OWNER_A, SELLER, TEST_NODE_SEED, budgetTerms, signVoucher, startFakeChain, tempDir, testKey } from "./helpers.ts";

const tmp = tempDir("payminto-hints-");
const T0 = 1_800_000_000;
const agent = testKey(1);
let chain: FakeChain;
let db: Database;
let vouchers: VoucherService;
let nowSec = T0;
let budgetId = "";
const cumulative = new Map<AccountId, bigint>();

const provider = (id: string, payee: AccountId, price: bigint): ProviderRow => {
  db.run("INSERT INTO providers (id, name, description, payee, price_atomic, resource, category, api_key_hash, created_at) VALUES (?, ?, '', ?, ?, 'r', 'api', ?, 'now')", id, id, payee, price.toString(), `hash-${id}`);
  return db.get<ProviderRow>("SELECT * FROM providers WHERE id = ?", id)!;
};

async function pay(p: ProviderRow, request = `req-${Math.random()}`): Promise<"ok" | { rule: string; retry: RetryHint }> {
  const amount = BigInt(p.price_atomic);
  const next = (cumulative.get(p.payee) ?? 0n) + amount;
  const v = { budgetId, payee: p.payee, amount, cumulative: next, requestHash: sha256Text(request) };
  const r = await vouchers.accept(p, { ...v, signature: signVoucher(chain, agent, v) });
  if (r.ok) {
    cumulative.set(p.payee, next);
    return "ok";
  }
  return { rule: r.rule, retry: r.refusal.retry };
}

beforeAll(() => {
  chain = startFakeChain();
  db = new Database(join(tmp.dir, "hints.test.db"));
  db.migrate();
  const store = new Store(db);
  const client = new ChainClient(chain, keypairFromSeed(Buffer.from(TEST_NODE_SEED, "hex")));
  const events = new EventBus(db);
  vouchers = new VoucherService({ db, store, chain: client, ledger: new Ledger(db), events, funds: new FundsTracker(store, client, events, silentLogger, () => nowSec * 1000), log: silentLogger, clockMs: () => nowSec * 1000 });

  // 3,000 an hour, 5,000 a day, 2 calls a minute, 2 payments per request. Valid for a week of the test clock.
  const policy: Policy = { perCallCap: "2500", hourlyCap: "3000", dailyCap: "5000", maxCallsPerMinute: 2, maxRepeatsPerRequest: 2, purpose: "hints" };
  const { terms } = budgetTerms(OWNER_A, agent, { policy, validUntil: BigInt(T0 + 7 * 86_400) * 1000n });
  budgetId = chain.openBudget(OWNER_A, terms);
  chain.depositBudget(OWNER_A, budgetId, 1_000_000n);
  db.run(
    "INSERT INTO budgets (id, owner, agent, settler, cap, valid_until_ms, policy_hash, salt, policy, payees, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'hints', 'open', 'now')",
    budgetId,
    OWNER_A,
    agent.publicKey,
    terms.settler,
    terms.cap.toString(),
    Number(terms.validUntil),
    terms.policyHash,
    terms.salt,
    canonicalPolicy(policy),
  );
});

afterAll(() => {
  db.close();
  tmp.cleanup();
});

describe("rolling-limit retry hints", () => {
  let small: ProviderRow;
  let large: ProviderRow;

  beforeAll(() => {
    small = provider("prv_small", SELLER, 1_000n);
    large = provider("prv_large", "big.seller.testnet", 2_000n);
  });

  it("answers RATE_LIMIT with the seconds until the oldest call of the minute leaves it", async () => {
    expect(await pay(small)).toBe("ok"); // T0
    nowSec = T0 + 25;
    expect(await pay(small)).toBe("ok"); // T0 + 25
    nowSec = T0 + 40;
    // Two calls in the last 60 s. The one from T0 leaves the window at T0 + 60: 20 s from now, not 60.
    expect(await pay(small)).toEqual({ rule: "RATE_LIMIT", retry: { kind: "after", seconds: 20 } });
    nowSec = T0 + 60;
    expect(await pay(small)).toBe("ok"); // T0 + 60, the third 1,000 of the hour
  });

  it("answers HOURLY_CAP with the seconds until enough spend leaves the hour for this call", async () => {
    nowSec = T0 + 1_300;
    // 3,000 spent this hour. A 1,000 call needs the call from T0 to leave: at T0 + 3,600.
    expect(await pay(small)).toEqual({ rule: "HOURLY_CAP", retry: { kind: "after", seconds: 2_300 } });
    // A 2,000 call needs the calls from T0 and T0 + 25 to leave: at T0 + 3,625.
    expect(await pay(large)).toEqual({ rule: "HOURLY_CAP", retry: { kind: "after", seconds: 2_325 } });
  });

  it("waits for the daily cap too when the retry would only meet it next", async () => {
    nowSec = T0 + 3_625;
    expect(await pay(large)).toBe("ok"); // 5,000 spent today; 3,000 in the last hour (T0 + 60 and this call)
    nowSec = T0 + 3_650;
    // The hour frees 1,000 in 10 s (at T0 + 3,660), but the day stays full until the call from T0 leaves it at T0 + 86,400.
    expect(await pay(small)).toEqual({ rule: "HOURLY_CAP", retry: { kind: "after", seconds: 86_400 - 3_650 } });
  });

  it("answers REPEAT_REQUEST with the seconds until the oldest counted repeat leaves its window", async () => {
    nowSec = T0 + 90_000; // a day later: every earlier call has left the hour and the day
    expect(await pay(small, "same")).toBe("ok");
    nowSec = T0 + 90_100;
    expect(await pay(small, "same")).toBe("ok");
    nowSec = T0 + 90_700;
    expect(await pay(small, "same")).toEqual({ rule: "REPEAT_REQUEST", retry: { kind: "after", seconds: REPEAT_WINDOW_SEC - 700 } });
    nowSec = T0 + 90_000 + REPEAT_WINDOW_SEC;
    expect(await pay(small, "same")).toBe("ok");
  });

  it("says never when the Budget expires before the window frees up", async () => {
    // Two calls this minute and the Budget expires in 30 s: the minute frees up only after the Budget is gone.
    nowSec = T0 + 7 * 86_400 - 30;
    expect(await pay(small, "late 1")).toBe("ok");
    expect(await pay(small, "late 2")).toBe("ok");
    expect(await pay(small, "late 3")).toEqual({ rule: "RATE_LIMIT", retry: { kind: "never" } });
  });
});
