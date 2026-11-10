import { describe, expect, it } from "vitest";
import { agentSnippets } from "@/components/gateway/share-sheet";

const LINK = "https://pay.example.com/l/quarterly-report";
const ctx = { network: "near:testnet", hub: "hub.payminto.testnet", nodeUrl: "https://node.example.com", amount: "25000000" };

describe("agentSnippets", () => {
  it("pays a link with AgentClient from the SDK, a voucher signed by the Budget key", () => {
    const { sdk } = agentSnippets(LINK, false, ctx);
    expect(sdk).toContain('import { AgentClient, defaultAgentKeyPath, readAgentKeyFile } from "@payminto/sdk";');
    expect(sdk).toContain('network: "near:testnet",');
    expect(sdk).toContain('hub: "hub.payminto.testnet",');
    expect(sdk).toContain('nodeUrl: "https://node.example.com",');
    expect(sdk).toContain(`await agent.pay("${LINK}", { headers: { accept: "application/json" } }, { maxPrice: 25_000_000n });`);
    expect(sdk).toContain("payment.status, payment.paid");
  });
  it("no longer shows the call or the offer from before NEAR", () => {
    const s = agentSnippets(LINK, false, ctx);
    for (const text of Object.values(s)) {
      expect(text).not.toMatch(/payExact|EIP-3009|txHash|0x/);
      expect(text).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
    }
    expect(s.curl).toContain("x402 version 2: one payminto-voucher offer on near:testnet");
    expect(s.curl).toContain("receipts, positions");
  });
  it("adds the amount for a link that lets the payer choose it", () => {
    const s = agentSnippets(LINK, true, ctx);
    expect(s.curl).toContain(`"${LINK}?amount=5000000"`);
    expect(s.sdk).toContain(`agent.pay("${LINK}?amount=5000000"`);
    expect(s.sdk).toContain("maxPrice: 5_000_000n");
    expect(s.mcp).toContain(`pay_link({ url: "${LINK}", amountAtomic: "5000000" })`);
    expect(agentSnippets(LINK, false, ctx).mcp).toContain(`pay_link({ url: "${LINK}" })`);
  });
  it("names what to fill in until the server's details have loaded", () => {
    const { sdk } = agentSnippets(LINK, false);
    expect(sdk).toContain('hub: "<hub account>",');
    expect(sdk).toContain('nodeUrl: "<your Payminto server>",');
    expect(sdk).toContain("maxPrice: 5_000_000n");
  });
});
