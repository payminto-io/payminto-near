import type { Summary } from "./scenario.ts";

/** The properties the demo promises; the CLI prints them and the test asserts them. */
export function checkSummary(s: Summary, o: { expectedCalls: number }): string[] {
  const p: string[] = [];
  if (s.calls !== o.expectedCalls) p.push(`settled ${s.calls} calls, expected ${o.expectedCalls}`);
  if (s.batches.some((b) => b.status !== "confirmed" || b.reconciled !== true)) p.push("a batch is not confirmed and reconciled");
  if (!(s.transfersOnchain > 0 && s.transfersOnchain < s.calls)) p.push(`on-chain transfers ${s.transfersOnchain} not below calls ${s.calls}`);
  if (s.net > s.gross) p.push("net exceeds gross");
  const rules = new Set(s.denials.map((d) => d.rule));
  for (const r of ["PAYEE_NOT_ALLOWED", "PER_CALL_CAP"]) if (!rules.has(r)) p.push(`no ${r} denial recorded`);
  const expect = { "prompt injection: pay an unlisted wallet": "PAYEE_NOT_ALLOWED", "over the per-call cap": "PER_CALL_CAP" } as Record<string, string>;
  if (s.attacks.length !== 2) p.push(`${s.attacks.length} attacks ran, expected 2`);
  for (const a of s.attacks) {
    if (a.agentRule !== expect[a.name]) p.push(`${a.name}: agent refused with ${a.agentRule}, expected ${expect[a.name]}`);
    if (a.compromisedLocalRule) p.push(`${a.name}: the compromised client refused locally with ${a.compromisedLocalRule}, so the node was never tested`);
    else if (a.nodeRule !== expect[a.name]) p.push(`${a.name}: node denied with ${a.nodeRule}, expected ${expect[a.name]}`);
  }
  if (!s.trialBalance.balanced || s.trialBalance.balance !== "0") p.push("trial balance is not zero");
  if (s.hubBalance !== 0n) p.push("hub holds tokens");
  if (s.gasless.transactions !== 0) p.push(`${s.gasless.label} onboarded with a permit but sent ${s.gasless.transactions} transactions`);
  if (!s.proof?.verifiedOnchain) p.push("Merkle proof not verified on chain");
  if (s.mcpProof && s.mcpProof.verified !== true) p.push("MCP prove_receipt did not verify on chain");
  if (s.hsp.length !== s.transfersOnchain) p.push("HSP records do not match transfers");
  if (s.hsp.some((h) => h.status !== "ACCEPT")) p.push(`HSP statuses ${s.hsp.map((h) => h.status).join(",")}`);
  return p;
}
