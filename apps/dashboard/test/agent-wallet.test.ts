import { describe, expect, it } from "vitest";
import { maxUint256 } from "viem";
import { isUnlimited } from "@/components/app/agent-wallet";

describe("isUnlimited", () => {
  it("flags max uint256 approvals so the card never prints a 78-digit allowance", () => {
    expect(isUnlimited(maxUint256)).toBe(true);
    expect(isUnlimited(2n ** 255n)).toBe(true);
  });

  it("shows real caps as amounts", () => {
    expect(isUnlimited(25_000_000n)).toBe(false);
    expect(isUnlimited(0n)).toBe(false);
  });
});
