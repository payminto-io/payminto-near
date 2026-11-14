import { describe, expect, it } from "vitest";
import { checkoutWords } from "@/lib/disclosures";

const sandbox = { network: { id: "near:sandbox", name: "Local NEAR sandbox" } };

describe("what the checkout says about where the money goes", () => {
  it("a live any-chain server: real money on NEAR mainnet, straight to the business, never a local sandbox escrow", () => {
    const w = checkoutWords({ ...sandbox, mode: { livemode: true, any_chain: "live" } });
    expect(w.networkName).toBe("NEAR mainnet");
    expect(w.escrowShort).toBe("Paid through NEAR Intents straight to the business's own account, never held by Payminto");
    expect(w.escrowShort).not.toMatch(/sandbox|escrow/i);
  });

  it("a test server keeps naming its own network and the escrow", () => {
    const w = checkoutWords({ ...sandbox, mode: { livemode: false, any_chain: "simulated" } });
    expect(w.networkName).toBe("Local NEAR sandbox");
    expect(w.escrowShort).toBe("Funds are escrowed in an unaudited contract on a local NEAR sandbox");
    expect(checkoutWords({ network: { id: "near:testnet", name: "NEAR testnet" } }).escrowShort).toBe("Funds are escrowed in an unaudited contract on NEAR testnet");
  });
});
