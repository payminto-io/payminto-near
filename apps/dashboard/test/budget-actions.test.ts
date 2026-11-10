import { describe, expect, it } from "vitest";
import { escrowShortfall } from "@/components/app/budget-actions";

const spend = (settled: string) => ({ settled, pending: "0", today: "0", remaining: "0" });

describe("escrowShortfall", () => {
  it("is what the cap still needs beyond escrow and settled spend", () => {
    expect(escrowShortfall({ cap: "1000", escrow: "300", spend: spend("200") })).toBe(500n);
  });
  it("is zero when escrow covers the cap, and treats an unread escrow as empty", () => {
    expect(escrowShortfall({ cap: "1000", escrow: "1000", spend: spend("0") })).toBe(0n);
    expect(escrowShortfall({ cap: "1000", escrow: null, spend: spend("0") })).toBe(1000n);
  });
});
