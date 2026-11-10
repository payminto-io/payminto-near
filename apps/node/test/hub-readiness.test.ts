/**
 * What the node checks on the hub at startup: its receipt key is registered for its account, so sellers can use
 * `settle_own` with the acceptances it signs, and its prepaid storage balance covers a batch.
 */
import { describe, expect, it } from "vitest";
import { FakeChain } from "@payminto/chain/fake";
import { ChainClient } from "../src/chain.ts";
import { hubReadinessProblems, MIN_SETTLE_STORAGE_YOCTO } from "../src/hub-readiness.ts";
import { testKey } from "./helpers.ts";

const OPERATOR = "node.readiness.testnet";

function hub(storageYocto?: bigint) {
  const fake = new FakeChain({ operator: OPERATOR });
  fake.addSettler(OPERATOR, storageYocto);
  return fake;
}

describe("hub readiness", () => {
  it("reports nothing when the node's receipt key is registered and its storage is prepaid", async () => {
    const fake = hub();
    const key = testKey(90);
    await fake.registerReceiptKey(OPERATOR, key.publicKey);
    expect(await hubReadinessProblems(new ChainClient(fake, key))).toEqual([]);
  });

  it("reports a receipt key the hub does not hold for this settler, naming the key and the fix", async () => {
    const fake = hub();
    const key = testKey(90);
    const none = await hubReadinessProblems(new ChainClient(fake, key));
    expect(none.map((p) => p.check)).toEqual(["receipt_key_registered"]);
    expect(none[0]!.message).toContain(key.publicKey);
    expect(none[0]!.message).toMatch(/no receipt key.*register_receipt_key/);

    // Another key is registered, for example after NODE_SIGNING_SEED changed: still a problem.
    const other = testKey(91);
    await fake.registerReceiptKey(OPERATOR, other.publicKey);
    const wrong = await hubReadinessProblems(new ChainClient(fake, key));
    expect(wrong.map((p) => p.check)).toEqual(["receipt_key_registered"]);
    expect(wrong[0]!.message).toContain(other.publicKey);
  });

  it("reports a storage balance below one full batch", async () => {
    const key = testKey(90);
    const low = hub(MIN_SETTLE_STORAGE_YOCTO / 2n);
    await low.registerReceiptKey(OPERATOR, key.publicKey);
    const problems = await hubReadinessProblems(new ChainClient(low, key));
    expect(problems.map((p) => p.check)).toEqual(["settle_storage_balance"]);
    expect(problems[0]!.message).toMatch(/INSUFFICIENT_STORAGE.*fund_storage/);

    const empty = hub(0n);
    expect((await hubReadinessProblems(new ChainClient(empty, key))).map((p) => p.check)).toEqual(["receipt_key_registered", "settle_storage_balance"]);
    // The threshold is one worst-case batch of 100 claims, about 0.37 NEAR.
    expect(MIN_SETTLE_STORAGE_YOCTO).toBe(369_130_000_000_000_000_000_000n);
  });
});
