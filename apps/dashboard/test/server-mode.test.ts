import { describe, expect, it } from "vitest";
import { LIVE_MODE_LOCKED_REASON, environmentNotice, lockedForMode, serverMode } from "@/lib/server-mode";

const sandbox = { network: { id: "near:sandbox", testnet: true } };
const testnet = { network: { id: "near:testnet", testnet: true } };
const mainnet = { network: { id: "near:mainnet", testnet: false } };

describe("one mode per server: Test or Live", () => {
  it("reads the mode the server reports, and falls back to the network for an older server", () => {
    expect(serverMode({ ...sandbox, mode: { livemode: true, any_chain: "live" } })).toBe("live");
    expect(serverMode({ ...sandbox, mode: { livemode: false, any_chain: "simulated" } })).toBe("test");
    expect(serverMode(sandbox)).toBe("test");
    expect(serverMode(mainnet)).toBe("live");
  });

  it("test mode says test tokens and no real money, naming the network", () => {
    expect(environmentNotice({ ...sandbox, mode: { livemode: false, any_chain: "simulated" } })).toEqual({
      tone: "test",
      text: "Test mode: test tokens on a local test network. No real money moves.",
    });
    expect(environmentNotice({ ...testnet, mode: { livemode: false, any_chain: "off" } })?.text).toBe("Test mode: test tokens on NEAR testnet. No real money moves.");
  });

  it("live mode with a test-network hub never says 'no real money'", () => {
    const n = environmentNotice({ ...sandbox, mode: { livemode: true, any_chain: "live" } });
    expect(n).toEqual({ tone: "live", text: "Live mode: real money. Customers pay from other chains and USDC arrives in your NEAR mainnet account." });
    expect(n?.text).not.toMatch(/no real money/i);
  });

  it("a new business on a live any-chain server starts with the test-money methods locked off, as the server keeps them", () => {
    const rows = [
      { method: "wallet" as const, enabled: true, locked_reason: null },
      { method: "voucher" as const, enabled: true, locked_reason: null },
    ];
    const live = { ...sandbox, mode: { livemode: true, any_chain: "live" as const } };
    expect(lockedForMode(rows, live)).toEqual([
      { method: "wallet", enabled: false, locked_reason: LIVE_MODE_LOCKED_REASON },
      { method: "voucher", enabled: false, locked_reason: LIVE_MODE_LOCKED_REASON },
    ]);
    expect(LIVE_MODE_LOCKED_REASON).toBe("Off in live mode: the hub runs on a test network, and this server takes only real money from other chains.");
    expect(lockedForMode(rows, { ...sandbox, mode: { livemode: false, any_chain: "simulated" } })).toBe(rows);
    expect(lockedForMode(rows, undefined)).toBe(rows);
  });

  it("a mainnet server shows the live strip too, and demo data wins over both", () => {
    expect(environmentNotice({ ...mainnet, mode: { livemode: true, any_chain: "off" } })).toEqual({ tone: "live", text: "Live mode: real money on NEAR mainnet." });
    expect(environmentNotice(sandbox, { mock: true })).toEqual({ tone: "demo", text: "Demo data: this screen shows sample data and nothing touches a chain." });
  });
});
