/**
 * The per-task spend ceiling against sellers that take the money and do not deliver. The ceiling counts what left the
 * Budget (and what may still leave it), whatever the paying tool answered: a success, an error, or a refusal.
 * Scripted model, in-memory wallet stand-in with the real result shapes.
 */
import { describe, expect, it } from "vitest";
import { BUYER_SYSTEM } from "../src/prompts.ts";
import { renderRun, runAgent } from "../src/runtime.ts";
import { lastToolResults, scriptedModel, type ScriptStep } from "../src/scripted.ts";
import { fakeWallet, FLAKY, FORGER, GOUGER, LIAR, MARKET } from "./fake-wallet.ts";

const PRICE = 2_000n;
const buy = (id: string) => ({ name: "call_paid_service", input: { serviceId: id } });
/** A model that keeps retrying a failing service, three calls per turn, for `turns` turns. */
const stubborn = (id: string, turns: number): ScriptStep[] => [...Array.from({ length: turns }, () => ({ toolUses: [buy(id), buy(id), buy(id)] })), { text: "gave up" }];

describe("H3: paid calls that fail count against the task ceiling", () => {
  it("books the receipt of a call that answered an error, and stops at the ceiling", async () => {
    const w = await fakeWallet({ services: [FLAKY] });
    const model = scriptedModel(stubborn(FLAKY.id, 5));
    const r = await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "get data", limits: { maxSpendAtomic: 2n * PRICE } });
    await w.host.close();
    // Two calls fit. The third of the same turn is refused before the wallet sees it, and the run ends over-ceiling.
    expect(w.spent.value).toBe(2n * PRICE);
    expect(w.calls.filter((c) => c.name === "call_paid_service")).toHaveLength(2);
    expect(r.status).toBe("spend_ceiling");
    expect(r.note).toBe("stopped: this task spent 0.004 USDC, which reaches its spend ceiling of 0.004 USDC");
    expect(model.requests).toHaveLength(1);
    expect(r.spend).toMatchObject({ spentAtomic: "4000", ceilingAtomic: "4000", unverified: [] });
    expect(r.spend!.receipts.map((x) => [x.tool, x.service, x.amountAtomic])).toEqual([
      ["call_paid_service", "Flaky Data", "2000"],
      ["call_paid_service", "Flaky Data", "2000"],
    ]);
    expect(r.spend!.refusals).toEqual([expect.objectContaining({ rule: "TASK_SPEND_CEILING", enforcedBy: "runtime" })]);
    expect(r.toolCalls.map((t) => t.isError)).toEqual([true, true, true]);
  });

  it("never spends past the ceiling, and a run that stays under it is not over-ceiling", async () => {
    const w = await fakeWallet({ services: [FLAKY] });
    const model = scriptedModel(stubborn(FLAKY.id, 5));
    const r = await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "get data", limits: { maxSpendAtomic: 5_000n } });
    await w.host.close();
    // 2000 + 2000 fit under 5000; a third 2000 does not, in any later turn either.
    expect(w.spent.value).toBe(4_000n);
    expect(w.calls.filter((c) => c.name === "call_paid_service")).toHaveLength(2);
    expect(r.status).toBe("completed");
    expect(r.spend).toMatchObject({ spentAtomic: "4000" });
    expect(r.spend!.refusals.every((x) => x.rule === "TASK_SPEND_CEILING")).toBe(true);
    expect(r.spend!.refusals).toHaveLength(13);
  });

  it("reads the Budget after every paying call, so a wallet that says nothing about a failed call is still counted", async () => {
    const w = await fakeWallet({ services: [FLAKY], legacy: true });
    const model = scriptedModel(stubborn(FLAKY.id, 5));
    const r = await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "get data", limits: { maxSpendAtomic: 2n * PRICE } });
    await w.host.close();
    expect(w.spent.value).toBe(2n * PRICE);
    expect(r.status).toBe("spend_ceiling");
    // No receipt came back with the errors: the spend is the Budget's own delta.
    expect(r.spend).toMatchObject({ spentAtomic: "4000", receipts: [] });
    // One Budget read before the first turn, one after each paying call, one at the end.
    expect(w.calls.filter((c) => c.name === "get_budget")).toHaveLength(4);
  });

  it("counts a voucher with an unknown outcome as spent", async () => {
    const w = await fakeWallet({ services: [FORGER] });
    const model = scriptedModel(stubborn(FORGER.id, 3));
    const r = await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "get data", limits: { maxSpendAtomic: 2n * PRICE } });
    await w.host.close();
    // The Budget did not move (the node booked nothing), and the two vouchers that are out still count.
    expect(w.spent.value).toBe(0n);
    expect(r.status).toBe("spend_ceiling");
    expect(r.spend).toMatchObject({ spentAtomic: "4000", receipts: [] });
    expect(r.spend!.unverified.map((x) => [x.service, x.amountAtomic, x.note])).toEqual([
      ["Forged Receipts", "2000", "this agent's node has not booked the voucher"],
      ["Forged Receipts", "2000", "this agent's node has not booked the voucher"],
    ]);
    expect(renderRun(r)).toMatch(/unverified 0x0+1 +0\.002 USDC {2}Forged Receipts {2}-> \S+ \(voucher sent, outcome unknown: counted as spent\)/);
  });

  it("books what a refused call paid, and reports the refusal as the seller's word", async () => {
    const w = await fakeWallet({ services: [LIAR] });
    const model = scriptedModel([
      { toolUses: [buy(LIAR.id)] },
      (req) => {
        expect(lastToolResults(req)[0]).toMatchObject({ isError: true });
        return { text: "The seller said the payment was refused, and the wallet says it was paid." };
      },
    ]);
    const r = await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "get data" });
    await w.host.close();
    expect(r.spend).toMatchObject({ spentAtomic: "2000", receipts: [{ service: "False Refusals", amountAtomic: "2000" }] });
    expect(r.spend!.refusals).toEqual([expect.objectContaining({ rule: "DAILY_CAP", enforcedBy: "seller", target: "False Refusals" })]);
    expect(renderRun(r)).toMatch(/refused DAILY_CAP \(seller,/);
  });

  it("gives the wallet what is left under the ceiling as the call's maximum price", async () => {
    // The directory lists 2000, so the runtime's own price check passes; the seller then asks for 9000.
    const w = await fakeWallet({ services: [GOUGER, MARKET] });
    const model = scriptedModel([
      { toolUses: [buy(MARKET.id)] },
      { toolUses: [{ name: "call_paid_service", input: { serviceId: GOUGER.id, maxAmountAtomic: "999999999" } }] },
      (req) => {
        expect(lastToolResults(req)[0]!.text).toMatch(/^Payment denied by wallet rule CLIENT_MAX_PRICE/);
        return { text: "The price was above what this task may still spend." };
      },
    ]);
    const r = await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "get data", limits: { maxSpendAtomic: 5_000n } });
    await w.host.close();
    const sent = w.calls.filter((c) => c.name === "call_paid_service").map((c) => c.args.maxAmountAtomic);
    // 5000 before anything was spent, then 3000: the model's own larger maximum does not widen it.
    expect(sent).toEqual(["5000", "3000"]);
    expect(w.spent.value).toBe(PRICE);
    expect(r.status).toBe("completed");
    expect(r.spend!.refusals).toEqual([expect.objectContaining({ rule: "CLIENT_MAX_PRICE", enforcedBy: "agent", attemptedAmount: "9000" })]);
  });

  it("keeps a lower maximum the model asked for", async () => {
    const w = await fakeWallet({ services: [MARKET] });
    const model = scriptedModel([{ toolUses: [{ name: "call_paid_service", input: { serviceId: MARKET.id, maxAmountAtomic: "1000" } }] }, { text: "too expensive" }]);
    await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "get data", limits: { maxSpendAtomic: 5_000n } });
    await w.host.close();
    expect(w.calls.filter((c) => c.name === "call_paid_service").map((c) => c.args.maxAmountAtomic)).toEqual(["1000"]);
    expect(w.spent.value).toBe(0n);
  });

  it("ends over-ceiling, not completed, when the last Budget read shows the ceiling was reached", async () => {
    const w = await fakeWallet({ services: [MARKET] });
    const model = scriptedModel([
      { toolUses: [buy(MARKET.id)] },
      () => {
        // A voucher sent earlier is booked by the node while the model writes its answer.
        w.spent.value += 3_000n;
        return { text: "Here is the quote." };
      },
    ]);
    const r = await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "get data", limits: { maxSpendAtomic: 5_000n } });
    await w.host.close();
    expect(r.status).toBe("spend_ceiling");
    expect(r.answer).toBe("Here is the quote.");
    expect(r.note).toBe("stopped: this task spent 0.005 USDC, which reaches its spend ceiling of 0.005 USDC");
    expect(r.spend).toMatchObject({ spentAtomic: "5000", receipts: [{ amountAtomic: "2000" }] });
  });

  it("does not call a run that spent nothing over-ceiling", async () => {
    const w = await fakeWallet({ services: [MARKET] });
    const model = scriptedModel([{ toolUses: [{ name: "list_paid_services", input: {} }, buy(MARKET.id)] }, { text: "Nothing may be spent on this task." }]);
    const r = await runAgent({ model, tools: w.host, system: BUYER_SYSTEM, task: "look only", limits: { maxSpendAtomic: 0n } });
    await w.host.close();
    expect(r.status).toBe("completed");
    expect(w.calls.some((c) => c.name === "call_paid_service")).toBe(false);
    expect(r.spend).toMatchObject({ spentAtomic: "0", refusals: [{ rule: "TASK_SPEND_CEILING" }] });
  });
});
