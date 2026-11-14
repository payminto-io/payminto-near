import { describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_QR_CAPTION,
  depositQr,
  destinationText,
  destinationVerifyNote,
  evmPayoutMessage,
  isEvmAddress,
  preselectOrigin,
  receiveOptions,
  sendNowAtomic,
  shortAddress,
} from "@/lib/intents";
import { testMoneyLabel } from "@/lib/disclosures";
import { checkoutViewSchema, intentsOptionsSchema, intentsPayoutSchema, intentsQuoteSchema, type IntentsOption, type IntentsQuote } from "@/lib/schemas";

const BASE_USDC = {
  asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  chain: "base",
  chain_name: "Base",
  symbol: "USDC",
  decimals: 6,
  contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  chain_id: 8453,
};
const ETH_BASE = { asset: "nep141:base.omft.near", chain: "base", chain_name: "Base", symbol: "ETH", decimals: 18, contract_address: null, chain_id: 8453 };
const DEPOSIT = "0x87151c5ac911a4459762ce215649313cd369dc05";
const usdc = (amount: string, formatted: string) => ({ amount, formatted, symbol: "USDC" });

function quote(over: Record<string, unknown> = {}): IntentsQuote {
  return intentsQuoteSchema.parse({
    id: "iq_1",
    object: "intents_quote",
    payment_id: "pay_1",
    mode: "simulated",
    label: "Simulated - no real money",
    status: "awaiting_deposit",
    provider_status: null,
    origin: BASE_USDC,
    deposit_address: DEPOSIT,
    deposit_memo: null,
    send_exactly: usdc("4509585", "4.509585"),
    min_amount_in: usdc("4505080", "4.505080"),
    amount_out: usdc("4500000", "4.500000"),
    amount_in_usd: "4.5",
    fees: {
      send_exactly: usdc("4509585", "4.509585"),
      merchant_receives: usdc("4500000", "4.500000"),
      swap_cost: { amount: "5080", formatted: "0.005080", unit: "USDC" },
      price_buffer: usdc("4505", "0.004505"),
      refund_fee: null,
      delivery_fee: null,
      time_estimate_sec: 35,
    },
    slippage_bps: 10,
    time_estimate_sec: 35,
    refund_to: "0x5f2b...554f",
    recipient: "anychain.test.near",
    settlement_network: "near:mainnet (simulated)",
    deadline: "2026-11-10T22:38:01.000Z",
    deadline_passed: false,
    inactive_at: null,
    deposited: null,
    delivered: null,
    refunded: null,
    refund_reason: null,
    origin_txs: [],
    destination_txs: [],
    near_txs: [],
    delivery_tx: null,
    verification: null,
    steps: [],
    warning: "Send only USDC on the Base network.",
    correlation_id: "c",
    signature_valid: true,
    created_at: "2026-11-10T22:08:01.512Z",
    updated_at: "2026-11-10T22:08:01.512Z",
    ...over,
  });
}

const row = (origin: typeof BASE_USDC | typeof ETH_BASE, available = true): IntentsOption =>
  ({ origin, available, reason: available ? null : "Too small.", slippage_bps: 10, amount_in: null, amount_in_usd: null, time_estimate_sec: null, fees: null }) as IntentsOption;

describe("the new contract fields parse, and an older server without them still parses", () => {
  it("origins carry contract_address and chain_id when sent", () => {
    expect(quote().origin).toMatchObject({ contract_address: BASE_USDC.contract_address, chain_id: 8453 });
    const old = quote({ origin: { asset: BASE_USDC.asset, chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6 } });
    expect(old.origin.contract_address ?? null).toBeNull();
    expect(old.destination ?? null).toBeNull();
  });
  it("the checkout view's intents may name a default origin", () => {
    const base = { id: "p", livemode: false, status: "open", merchant: { name: "A" }, description: null, reference: null, amount: "1", amount_due: "1", amount_paid: "0", amount_remaining: "1", token: { address: "usdc.near", symbol: "USDC", decimals: 6 }, hub: "hub.near", methods: [], order_hash: "ab".repeat(32), expires_at: "2026-11-10T23:00:00Z", created_at: "2026-11-10T22:00:00Z" };
    const intents = { mode: "simulated", label: "x", available: true, reason: null, settlement_network: "n", active_quote: null };
    expect(checkoutViewSchema.parse({ ...base, intents: { ...intents, default_origin: BASE_USDC.asset } }).intents?.default_origin).toBe(BASE_USDC.asset);
    expect(checkoutViewSchema.parse({ ...base, intents }).intents?.default_origin ?? null).toBeNull();
  });
  it("options rows parse with and without the new origin fields", () => {
    const opts = { object: "intents_options", payment_id: "p", mode: "simulated", label: "x", amount_out: usdc("1", "0.000001"), recipient: "a.near", settlement_network: "n", quoted_at: "t", valid_until: "t", options: [row(BASE_USDC), row(ETH_BASE)] };
    expect(intentsOptionsSchema.parse(opts).options[1]!.origin.contract_address).toBeNull();
  });
  it("the payout carries the destination, the destinations and the default origin", () => {
    const p = intentsPayoutSchema.parse({
      object: "intents_payout",
      mode: "simulated",
      label: "x",
      settlement_network: "n",
      account: null,
      verified: false,
      checks: { exists: null, usdc_registered: null, proven: false, proven_at: null },
      usdc: { contract: "usdc.near", asset_id: "nep141:usdc.near", decimals: 6 },
      storage_step: null,
      enabled: false,
      proof_scope: { settlement_network: "n", hub: "hub.near" },
      checked_at: "t",
      default_origin: BASE_USDC.asset,
      destination: { chain: "base", chain_name: "Base", symbol: "USDC", asset: BASE_USDC.asset, address: "0xab", proven: true, verify: "provider_only" },
      destinations: [{ chain: "base", chain_name: "Base", symbol: "USDC", asset: BASE_USDC.asset, decimals: 6, verify: "provider_only" }],
    });
    expect(p.destination?.verify).toBe("provider_only");
    expect(p.destinations).toHaveLength(1);
  });
});

describe("the deposit QR: a payment request only when it names the deposit address itself", () => {
  const SOL_USDC = { asset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", chain: "sol", chain_name: "Solana", symbol: "USDC", decimals: 6, contract_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", chain_id: null };
  const SOL_DEPOSIT = "mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN";

  it("an EVM token holds the bare address: its EIP-681 request names the token contract first, where a wallet that reads only that address would send the money", () => {
    const make = vi.fn(() => "ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=0x87&uint256=4509585");
    expect(depositQr(quote(), false, make)).toEqual({ value: DEPOSIT, wallet: false });
    expect(make).not.toHaveBeenCalled();
  });
  it("a native coin holds the payment request, which starts with the deposit address", () => {
    const make = vi.fn(() => `ethereum:${DEPOSIT}@8453?value=1`);
    expect(depositQr(quote({ origin: ETH_BASE }), false, make)).toEqual({ value: `ethereum:${DEPOSIT}@8453?value=1`, wallet: true });
    expect(make).toHaveBeenCalledWith({ chain: "base", chainId: 8453, contractAddress: null, decimals: 18, symbol: "ETH" }, DEPOSIT, "4509585");
  });
  it("Solana Pay names the deposit address first, so a Solana token holds the request", () => {
    const make = vi.fn(() => "solana:x");
    expect(depositQr(quote({ origin: SOL_USDC, deposit_address: SOL_DEPOSIT }), false, make)).toEqual({ value: "solana:x", wallet: true });
  });
  it("after a short deposit, asks only for what is missing", () => {
    const make = vi.fn(() => "uri");
    depositQr(quote({ origin: ETH_BASE, status: "incomplete_deposit", deposited: usdc("2499431", "2.499431") }), false, make);
    expect(make).toHaveBeenCalledWith(expect.anything(), DEPOSIT, "2010154");
    expect(sendNowAtomic(quote({ status: "incomplete_deposit", deposited: usdc("2499431", "2.499431") }))).toBe("2010154");
    expect(sendNowAtomic(quote())).toBe("4509585");
  });
  it("falls back to the bare address when no request can be made, or when the buyer asks for the address only", () => {
    expect(depositQr(quote({ origin: ETH_BASE }), false, () => null)).toEqual({ value: DEPOSIT, wallet: false });
    const make = vi.fn(() => "uri");
    expect(depositQr(quote({ origin: ETH_BASE }), true, make)).toEqual({ value: DEPOSIT, wallet: false });
    expect(make).not.toHaveBeenCalled();
  });
  it("an older server's origin (no contract) is never taken for a native coin", () => {
    const make = vi.fn(() => null);
    expect(depositQr(quote({ origin: { asset: BASE_USDC.asset, chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6 } }), false, make)).toEqual({ value: DEPOSIT, wallet: false });
  });
  it("says what the wallet fills in", () => {
    expect(DEPOSIT_QR_CAPTION).toBe("Scan with your wallet: it fills in the address, network and amount");
  });
});

describe("the token customers see first", () => {
  const rows = [row(ETH_BASE), row(BASE_USDC)];
  it("picks the business's default when it is offered and available", () => {
    expect(preselectOrigin(rows, BASE_USDC.asset)).toBe(BASE_USDC.asset);
  });
  it("picks nothing when the default is not offered, greyed, or not set", () => {
    expect(preselectOrigin(rows, "nep141:other.near")).toBeNull();
    expect(preselectOrigin([row(BASE_USDC, false)], BASE_USDC.asset)).toBeNull();
    expect(preselectOrigin(rows, null)).toBeNull();
    expect(preselectOrigin(rows, undefined)).toBeNull();
  });
});

describe("where the business receives", () => {
  const amount = { formatted: "1.500000", symbol: "USDC" };
  it("names the chain and a short address for a destination off NEAR", () => {
    expect(destinationText(amount, { chain: "base", chain_name: "Base", symbol: "USDC", address: "0xab12cd34ef56ab12cd34ef56ab12cd34ef56abcd" })).toBe("1.50 USDC on Base to 0xab12...abcd");
  });
  it("stays 'on NEAR' without a destination or for NEAR", () => {
    expect(destinationText(amount, null)).toBe("1.50 USDC on NEAR");
    expect(destinationText(amount, undefined)).toBe("1.50 USDC on NEAR");
    expect(destinationText(amount, { chain: "near", chain_name: "NEAR", symbol: "USDC", address: "shop.near" })).toBe("1.50 USDC on NEAR");
  });
  it("shortens only long addresses", () => {
    expect(shortAddress("shop.near")).toBe("shop.near");
    expect(shortAddress("0xab12cd34ef56ab12cd34ef56ab12cd34ef56abcd")).toBe("0xab12...abcd");
  });
  it("lists USDC on NEAR first, and NEAR alone for an older server", () => {
    const list = receiveOptions([
      { chain: "base", chain_name: "Base", symbol: "USDC", asset: "a", decimals: 6, verify: "provider_only" },
      { chain: "near", chain_name: "NEAR", symbol: "USDC", asset: "n", decimals: 6, verify: "rpc" },
    ]);
    expect(list.map((d) => d.chain)).toEqual(["near", "base"]);
    expect(receiveOptions(undefined).map((d) => `${d.symbol} on ${d.chain_name}`)).toEqual(["USDC on NEAR"]);
  });
  it("says plainly when deliveries are confirmed by NEAR Intents' report only", () => {
    expect(destinationVerifyNote({ chain_name: "Base", verify: "provider_only" })).toBe("Deliveries to Base are confirmed by NEAR Intents' report. This server cannot read Base itself.");
    expect(destinationVerifyNote({ chain_name: "NEAR", verify: "rpc" })).toBeNull();
  });
});

describe("the EVM payout proof", () => {
  it("is the exact message the server checks, with the address lowercased and the chain's EIP-155 id", () => {
    expect(evmPayoutMessage("mer_1", "0xAB12cd34EF56ab12cd34ef56ab12cd34ef56ABCD", 1_794_000_000, "base", "hub.near")).toBe(
      "Payminto intents payout mer_1 0xab12cd34ef56ab12cd34ef56ab12cd34ef56abcd 1794000000 network eip155:8453 hub hub.near",
    );
    expect(evmPayoutMessage("m", "0x1", 1, "eth", "h")).toContain("network eip155:1 ");
    expect(evmPayoutMessage("m", "0x1", 1, "arb", "h")).toContain("network eip155:42161 ");
    expect(evmPayoutMessage("m", "0x1", 1, "pol", "h")).toContain("network eip155:137 ");
    expect(evmPayoutMessage("m", "0x1", 1, "op", "h")).toContain("network eip155:10 ");
    expect(evmPayoutMessage("m", "0x1", 1, "sol", "h")).toBeNull();
  });
  it("checks the address shape", () => {
    expect(isEvmAddress("0xab12cd34ef56ab12cd34ef56ab12cd34ef56abcd")).toBe(true);
    expect(isEvmAddress("0xab12")).toBe(false);
    expect(isEvmAddress("shop.near")).toBe(false);
  });
});

describe("the test-money badge", () => {
  it("is hidden whenever the payment is live, even on a local sandbox", () => {
    expect(testMoneyLabel(true, "near:sandbox")).toBeNull();
    expect(testMoneyLabel(true, "near:testnet")).toBeNull();
    expect(testMoneyLabel(false, "near:sandbox")).toBe("Local sandbox");
  });
});
