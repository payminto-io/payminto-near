import { describe, expect, it } from "vitest";
import { isVerified, proofChecks } from "@/lib/proof";

const H = `0x${"ab".repeat(32)}` as const;

describe("proofChecks", () => {
  it("passes every check for a settled, verified call", () => {
    const checks = proofChecks({ batchId: H, receiptsRoot: H, proof: [H, H], txHash: H, onchainVerified: true }, true);
    expect(checks.map((c) => c.state)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(isVerified(checks)).toBe(true);
    expect(checks[1]!.detail).toContain("2 sibling hashes");
  });

  it("leaves batch checks pending before settlement", () => {
    const checks = proofChecks({ batchId: null, receiptsRoot: null, proof: [], txHash: null, onchainVerified: null }, null);
    expect(checks.map((c) => c.state)).toEqual(["pass", "pending", "pending", "pending"]);
    expect(isVerified(checks)).toBe(false);
  });

  it("fails when the path or the hub disagree", () => {
    const checks = proofChecks({ batchId: H, receiptsRoot: H, proof: [H], txHash: H, onchainVerified: false }, false);
    expect(checks[1]!.state).toBe("fail");
    expect(checks[2]!.state).toBe("fail");
    expect(isVerified(checks)).toBe(false);
  });

  it("reports an unevaluated on-chain check as unknown", () => {
    const checks = proofChecks({ batchId: H, receiptsRoot: H, proof: [H], txHash: H, onchainVerified: null }, true);
    expect(checks[2]!.state).toBe("unknown");
  });
});
