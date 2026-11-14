import { describe, expect, it } from "vitest";
import { intentsPayoutDestinationSchema } from "@/lib/schemas";

describe("a business that has not set its any-chain account yet", () => {
  it("parses the destination the node sends before any account is saved (live run, 2026-11-14)", () => {
    const fromNode = {
      chain: "near",
      chain_name: "NEAR",
      symbol: "USDC",
      asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      address: null,
      proven: false,
      verify: "rpc",
    };
    expect(intentsPayoutDestinationSchema.parse(fromNode)).toMatchObject({ chain: "near", address: null, proven: false });
  });
});
