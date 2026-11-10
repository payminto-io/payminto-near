import { describe, expect, it, vi } from "vitest";
import { runDemo } from "../src/demo.ts";

async function demo() {
  const lines: string[] = [];
  const result = await runDemo((line) => lines.push(line));
  return { ...result, text: lines.join("\n") };
}

describe("attack demo", () => {
  it("signs what the user asked for and stops everything that came from injected text", async () => {
    const d = await demo();
    expect(d.log.map((e) => [e.payee, e.verdict, e.outcome, e.proceed])).toEqual([
      ["acme.testnet", "allow", "allowed", true],
      ["acrne.testnet", "block", "blocked", false],
      ["fast-refunds.testnet", "block", "blocked", false],
      ["fresh-vendor.testnet", "warn", "approved", true],
      ["quiet-drop.testnet", "warn", "approval_timeout", false],
      ["acme.testnet", "block", "blocked", false],
    ]);
    expect(d.signed).toEqual([
      { payee: "acme.testnet", amount: "2500000", from: "user" },
      { payee: "fresh-vendor.testnet", amount: "5000000", from: "user" },
    ]);
    expect(d.injected).toBe(3);
    expect(d.text).toContain("All 3 payments that came from injected text were refused before anything was signed.");
  });

  it("gives the reason for every stop", async () => {
    const { log } = await demo();
    expect(log[1]!.signals[0]).toMatchObject({ id: "lookalike_payee", severity: "block" });
    expect(log[2]!.signals[0]).toMatchObject({ id: "reported_by_several", severity: "block" });
    expect(log[4]!.signals.map((s) => s.id)).toEqual(expect.arrayContaining(["new_account", "token_unregistered"]));
    expect(log[4]!.approval).toMatchObject({ answer: "timeout" });
    expect(log[5]!.signals[0]).toMatchObject({ id: "check_failed", severity: "block" });
  });

  it("prints the log, and no report text or injected instruction inside it", async () => {
    const { text, log } = await demo();
    for (const entry of log) expect(text).toContain(`log:   ${JSON.stringify(entry)}`);
    expect(JSON.stringify(log)).not.toMatch(/delivered nothing|Ignore earlier instructions/);
  });

  it("is deterministic, makes no network call and runs in well under a second", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const started = Date.now();
    const first = await demo();
    const second = await demo();
    expect(second.text).toBe(first.text);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
