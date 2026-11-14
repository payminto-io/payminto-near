import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { intentsQuoteSchema, type CheckoutView, type IntentsDestinationOption, type IntentsPayout, type IntentsQuote } from "@/lib/schemas";

// The deposit QR asks @payminto/protocol for a wallet payment request; here it answers a fixed one, or null.
const uri = vi.hoisted(() => ({ value: "ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=0x87151c5ac911a4459762ce215649313cd369dc05&uint256=25025000" as string | null }));
vi.mock("@payminto/protocol", async (orig) => ({ ...(await orig<object>()), depositPaymentUri: vi.fn(() => uri.value) }));

const setIntentsPayout = vi.fn();
const setIntentsDefaultOrigin = vi.fn();
vi.mock("@/lib/session", () => ({ useApi: () => ({ gateway: { setIntentsPayout, setIntentsDefaultOrigin } }), useCan: () => () => true }));

import { AnyChainPanel } from "@/components/checkout/intents";
import { setEvmProvider } from "@/lib/evm-wallet";
import { excessReturned, linkOpensCheckout, returnedLabel } from "@/lib/intents";
import { CheckoutPanel } from "@/components/checkout/checkout";
import { checkoutModel } from "@/lib/checkout";
import { LinkPanel } from "@/components/checkout/link-screen";
import { MerchantRow } from "@/components/checkout/parts";
import { LinkQr } from "@/components/gateway/link-qr";
import { IntentsCard } from "@/components/gateway/intents-card";
import { DefaultOriginField, EvmPayoutForm, ReceiveAs } from "@/components/gateway/any-chain-settings";

const BASE_USDC = { asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6, contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", chain_id: 8453 };
const BASE_ETH = { asset: "nep141:base.omft.near", chain: "base", chain_name: "Base", symbol: "ETH", decimals: 18, contract_address: null, chain_id: 8453 };
const ETH_USDC = { asset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", chain: "eth", chain_name: "Ethereum", symbol: "USDC", decimals: 6, contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", chain_id: 1 };
const DEPOSIT = "0x87151c5ac911a4459762ce215649313cd369dc05";
const PAYOUT_EVM = "0xAB12cd34EF56ab12cd34ef56ab12cd34ef56ABCD";
const usdc = (amount: string, formatted: string) => ({ amount, formatted, symbol: "USDC" });

function wrap(ui: ReactNode, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

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
    send_exactly: usdc("25025000", "25.025000"),
    min_amount_in: usdc("25020000", "25.020000"),
    amount_out: usdc("25000000", "25.000000"),
    amount_in_usd: "25.02",
    fees: {
      send_exactly: usdc("25025000", "25.025000"),
      merchant_receives: usdc("25000000", "25.000000"),
      swap_cost: { amount: "5080", formatted: "0.005080", unit: "USDC" },
      price_buffer: usdc("20000", "0.020000"),
      refund_fee: null,
      delivery_fee: null,
      time_estimate_sec: 35,
    },
    slippage_bps: 10,
    time_estimate_sec: 35,
    refund_to: "0x5f2b...554f",
    recipient: "acme-store.near",
    settlement_network: "near:mainnet (simulated)",
    deadline: new Date(Date.now() + 20 * 60_000).toISOString(),
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
    steps: [{ key: "waiting", label: "Waiting for deposit", state: "current" }],
    warning: "Send only USDC on the Base network, to this address.",
    correlation_id: "c",
    signature_valid: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  });
}

function view(intents: Partial<NonNullable<CheckoutView["intents"]>> = {}): CheckoutView {
  return {
    id: "pay_1",
    livemode: false,
    status: "open",
    late: false,
    merchant: { name: "Acme Store", support_email: null },
    description: "Pro plan",
    reference: null,
    amount: "25000000",
    surcharge: "0",
    amount_due: "25000000",
    amount_paid: "0",
    amount_remaining: "25000000",
    network: "near:sandbox",
    token: { address: "usdc.test.near", symbol: "USDC", decimals: 6 },
    hub: "hub.test.near",
    method: null,
    methods: ["oneclick"],
    wallet: null,
    success_url: null,
    order_hash: "ab".repeat(32),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    created_at: new Date().toISOString(),
    intents: { mode: "simulated", label: "Simulated - no real money", available: true, reason: null, settlement_network: "near:mainnet (simulated)", active_quote: null, ...intents },
  } as CheckoutView;
}

const option = (origin: typeof BASE_USDC, available = true) => ({ origin, available, reason: available ? null : "Too small.", slippage_bps: 10, amount_in: available ? usdc("25025000", "25.025000") : null, amount_in_usd: null, time_estimate_sec: 35, fees: null });
const options = (rows: ReturnType<typeof option>[]) => ({ data: { options: rows }, isPending: false, isError: false, refetch: vi.fn() }) as never;
const checkoutApi = { intentsQuote: vi.fn(), createIntentsQuote: vi.fn(), simulateIntentsDeposit: vi.fn(), submitIntentsDeposit: vi.fn() } as never;

beforeEach(() => {
  uri.value = "ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=0x87151c5ac911a4459762ce215649313cd369dc05&uint256=25025000";
  setIntentsPayout.mockReset();
  setIntentsDefaultOrigin.mockReset();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })) as never;
});

describe("the payment link's QR code", () => {
  const link = { active: true, merchant: { name: "Acme Store" }, amount: "5000000", min_amount: null, max_amount: null, collect_email: false, collect_name: false, token: { address: "usdc.near", symbol: "USDC", decimals: 6 } } as never;

  it("is not shown on the buyer's page until asked for, and then says it opens this page and is not a payment address", () => {
    wrap(<LinkPanel link={link} shareUrl="https://pay.example/l/coffee" onSubmit={async () => undefined} />);
    expect(screen.queryByText("Scan to pay on your phone")).toBeNull();
    expect(screen.queryByTitle("QR code of https://pay.example/l/coffee")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open on another device" }));
    expect(screen.getByTitle("QR code of https://pay.example/l/coffee")).toBeInTheDocument();
    expect(screen.getByText("This code opens this page on your phone. It is not a payment address: you get one after you choose what to pay with.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("is not offered for a local address a phone cannot open", () => {
    wrap(<LinkPanel link={link} shareUrl="http://localhost:3210/l/coffee" onSubmit={async () => undefined} />);
    expect(screen.queryByRole("button", { name: "Open on another device" })).toBeNull();
  });

  it("the business's link page shows the same QR with Download PNG and SVG", () => {
    wrap(<LinkQr url="https://pay.example/l/coffee" file="payminto-coffee" />);
    expect(screen.getByTitle("QR code of https://pay.example/l/coffee")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PNG" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download SVG" })).toBeInTheDocument();
  });
});

describe("the deposit screen's QR is ready for a wallet", () => {
  const deposit = (q: IntentsQuote) => wrap(<AnyChainPanel view={view({ active_quote: q })} api={checkoutApi} streaming options={options([])} onRefresh={() => undefined} />);

  it("an EVM token's QR holds the bare deposit address, and the amount, network and address sit together with copy buttons", () => {
    deposit(quote());
    expect(screen.getByTitle(`QR code of the deposit address ${DEPOSIT}`)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Address only" })).toBeNull();
    expect(screen.getByText("The code holds the address only. Type the exact amount in your wallet.")).toBeInTheDocument();
    const block = screen.getByRole("group", { name: "What to send" });
    expect(within(block).getByText("25.025 USDC")).toBeInTheDocument();
    expect(within(block).getByText("USDC on Base")).toBeInTheDocument();
    expect(within(block).getByText(DEPOSIT)).toBeInTheDocument();
    expect(within(block).getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    expect(within(block).getByRole("button", { name: "Copy amount" })).toBeInTheDocument();
  });

  it("a native coin's QR holds the payment request, says what the wallet fills in, and switches to the bare address on request", () => {
    uri.value = `ethereum:${DEPOSIT}@8453?value=8339000000000000`;
    deposit(quote({ origin: BASE_ETH, send_exactly: { amount: "8339000000000000", formatted: "0.008339", symbol: "ETH" } }));
    expect(screen.getByTitle(`QR code of the payment request ${uri.value}`)).toBeInTheDocument();
    expect(screen.getByText("Scan with your wallet: it fills in the address, network and amount")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Address only" });
    fireEvent.click(toggle);
    expect(screen.getByTitle(`QR code of the deposit address ${DEPOSIT}`)).toBeInTheDocument();
    expect(screen.queryByText("Scan with your wallet: it fills in the address, network and amount")).toBeNull();
  });

  it("shows the bare address and no toggle when no payment request can be made", () => {
    uri.value = null;
    deposit(quote());
    expect(screen.getByTitle(`QR code of the deposit address ${DEPOSIT}`)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Address only" })).toBeNull();
  });

  it("names where the business receives: on NEAR by default, or the chain and address", () => {
    const { unmount } = deposit(quote());
    expect(screen.getByText("25.00 USDC on NEAR")).toBeInTheDocument();
    unmount();
    deposit(quote({ destination: { chain: "base", chain_name: "Base", symbol: "USDC", address: PAYOUT_EVM } }));
    expect(screen.getByText("25.00 USDC on Base to 0xAB12...ABCD")).toBeInTheDocument();
  });
});

describe("the business's intents card names where the money went", () => {
  it("says on NEAR by default", () => {
    wrap(<IntentsCard intents={{ mode: "simulated", label: "Simulated - no real money", quotes: [quote()] }} />);
    expect(screen.getByText("25.00 USDC on NEAR")).toBeInTheDocument();
    expect(screen.getByText("NEAR delivery")).toBeInTheDocument();
  });
  it("names the chain and the address of an EVM destination", () => {
    wrap(<IntentsCard intents={{ mode: "simulated", label: "Simulated - no real money", quotes: [quote({ destination: { chain: "base", chain_name: "Base", symbol: "USDC", address: PAYOUT_EVM } })] }} />);
    expect(screen.getByText("25.00 USDC on Base to 0xAB12...ABCD")).toBeInTheDocument();
    expect(screen.getByText(PAYOUT_EVM)).toBeInTheDocument();
    expect(screen.getByText("Base delivery")).toBeInTheDocument();
  });
});

describe("the buyer's receipt names where the business received", () => {
  it("shows the amount, chain and address of an EVM destination", () => {
    const paid = quote({ status: "confirmed", deposited: usdc("25025000", "25.025000"), delivered: usdc("25000000", "25.000000"), verification: "provider_only", destination: { chain: "base", chain_name: "Base", symbol: "USDC", address: PAYOUT_EVM } });
    const v = { ...view({ available: false, active_quote: paid }), status: "paid", method: "oneclick", amount_paid: "25000000", amount_remaining: "0", paid_at: new Date().toISOString() } as CheckoutView;
    wrap(
      <CheckoutPanel view={v} api={{} as never} live="live" model={checkoutModel(v, { now: Date.now(), signing: false })} methods={[]} active={null} quote={null} tabs={[]} tab={null} anyChain={false} options={{} as never} onPick={() => undefined} held={false} step="idle" setStep={() => undefined} refresh={() => undefined} hasWallet watched={false} />,
    );
    expect(screen.getByText("25.00 USDC on Base to 0xAB12...ABCD")).toBeInTheDocument();
    expect(screen.getByText("Acme Store received")).toBeInTheDocument();
  });
});

describe("the receipt of an any-chain payment whose quote is not on the page", () => {
  it("still says it was paid from another chain, never with a NEAR wallet", () => {
    const v = { ...view({ available: false, active_quote: null }), status: "paid", method: "oneclick", amount_paid: "25000000", amount_remaining: "0", paid_at: new Date().toISOString() } as CheckoutView;
    wrap(
      <CheckoutPanel view={v} api={{} as never} live="live" model={checkoutModel(v, { now: Date.now(), signing: false })} methods={[]} active={null} quote={null} tabs={[]} tab={null} anyChain={false} options={{} as never} onPick={() => undefined} held={false} step="idle" setStep={() => undefined} refresh={() => undefined} hasWallet watched={false} />,
    );
    expect(screen.getByText("Any chain (NEAR Intents)")).toBeInTheDocument();
    expect(screen.queryByText("NEAR wallet")).toBeNull();
  });
});

describe("the token customers see first", () => {
  const making = () => {
    const createIntentsQuote = vi.fn(async (_id: string, body: { origin_asset: string }) => quote({ id: `iq_${body.origin_asset.slice(10, 14)}`, origin: body.origin_asset === ETH_USDC.asset ? ETH_USDC : BASE_USDC }));
    return { createIntentsQuote, api: { intentsQuote: vi.fn(), createIntentsQuote, simulateIntentsDeposit: vi.fn(), submitIntentsDeposit: vi.fn() } as never };
  };

  it("is selected when the checkout opens, and its address is made at once: no refund address is asked for", async () => {
    const { createIntentsQuote, api } = making();
    wrap(<AnyChainPanel view={view({ default_origin: ETH_USDC.asset })} api={api} streaming options={options([option(BASE_USDC), option(ETH_USDC)])} onRefresh={() => undefined} />);
    expect(screen.getByRole("radio", { name: "USDC on Ethereum" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "USDC on Base" })).not.toBeChecked();
    await waitFor(() => expect(createIntentsQuote).toHaveBeenCalledWith("pay_1", { origin_asset: ETH_USDC.asset }, expect.any(String)));
    expect(await screen.findByText(/^Send exactly/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("is not selected when it is greyed for this payment, and the buyer's own pick wins and gets its own address", async () => {
    const { createIntentsQuote, api } = making();
    wrap(<AnyChainPanel view={view({ default_origin: ETH_USDC.asset })} api={api} streaming options={options([option(BASE_USDC), option(ETH_USDC, false)])} onRefresh={() => undefined} />);
    expect(screen.getByRole("radio", { name: "USDC on Ethereum" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "USDC on Base" })).toBeChecked();
    await waitFor(() => expect(createIntentsQuote).toHaveBeenCalledWith("pay_1", { origin_asset: BASE_USDC.asset }, expect.any(String)));
    expect(createIntentsQuote).toHaveBeenCalledTimes(1);
  });
});

describe("one screen: the chain, then the address to scan", () => {
  it("switching the chain asks for that chain's address, on the same screen", async () => {
    const createIntentsQuote = vi.fn(async (_id: string, body: { origin_asset: string }) => quote({ id: body.origin_asset === ETH_USDC.asset ? "iq_eth" : "iq_base", origin: body.origin_asset === ETH_USDC.asset ? ETH_USDC : BASE_USDC }));
    const api = { intentsQuote: vi.fn(), createIntentsQuote, simulateIntentsDeposit: vi.fn(), submitIntentsDeposit: vi.fn() } as never;
    wrap(<AnyChainPanel view={view()} api={api} streaming options={options([option(BASE_USDC), option(ETH_USDC)])} onRefresh={() => undefined} />);
    expect(await screen.findByRole("heading", { name: /on Base$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "USDC on Ethereum" }));
    await waitFor(() => expect(createIntentsQuote).toHaveBeenLastCalledWith("pay_1", { origin_asset: ETH_USDC.asset }, expect.any(String)));
    expect(await screen.findByRole("heading", { name: /on Ethereum$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "USDC on Base" }));
    // The address for Base is still on screen from before: no second request.
    expect(await screen.findByRole("heading", { name: /on Base$/ })).toBeInTheDocument();
    expect(createIntentsQuote).toHaveBeenCalledTimes(2);
  });

  it("while waiting, says so in one line, and keeps the fees and progress under Details", () => {
    wrap(<AnyChainPanel view={view({ active_quote: quote() })} api={checkoutApi} streaming options={options([option(BASE_USDC)])} onRefresh={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Waiting for your payment\. Send before \d\d:\d\d UTC/);
    const details = screen.getByText("Details").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByRole("list", { name: "Progress of your payment" })).toBeInTheDocument();
  });

  it("counts down to the time the node asked for, not 1Click's later refund deadline", () => {
    const sendBy = new Date(Date.now() + 25 * 60_000).toISOString();
    wrap(<AnyChainPanel view={view({ active_quote: quote({ send_by: sendBy, deadline: new Date(Date.now() + 3 * 86_400_000).toISOString() }) })} api={checkoutApi} streaming options={options([option(BASE_USDC)])} onRefresh={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent(`Send before ${sendBy.slice(11, 16)} UTC (24:`);
  });

  it("tells the buyer they are done as soon as their deposit arrives; the conversion finishes in the background", () => {
    const busy = quote({ status: "processing", deposited: usdc("25025000", "25.025000"), origin_txs: [{ hash: `0x${"ab".repeat(32)}`, explorer_url: "https://basescan.org/tx/0xab" }] });
    wrap(<AnyChainPanel view={view({ available: false, reason: "A payment for this checkout is already being confirmed.", active_quote: busy })} api={checkoutApi} streaming options={options([option(BASE_USDC)])} onRefresh={() => undefined} />);
    expect(screen.queryByText("A payment for this checkout is already being confirmed.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(screen.getByText("You're done. We received 25.025 USDC on Base. NEAR Intents is now converting it to USDC for Acme Store, usually within a minute; you can close this page.")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Network" })).toBeNull();
    expect(screen.queryByTitle(/QR code/)).toBeNull();
  });

  it("never tells a buyer who gave no address that the unused buffer came back to them", () => {
    const paid = quote({ status: "confirmed", refund_type: "INTENTS", refund_to: "acme-store.near", refunded: usdc("4506", "0.004506") });
    expect(excessReturned(paid)).toBeNull();
    expect(returnedLabel(paid)).toBe("Unused price buffer, in your NEAR Intents balance");
    expect(excessReturned({ ...paid, refund_type: "ORIGIN_CHAIN" })).toMatchObject({ amount: "0.004506 USDC" });
  });

  it("after a returned deposit, Try again shows a fresh address, and the buyer can pick another chain", async () => {
    const returned = quote({ status: "refunded", deposited: usdc("1000000", "1.000000"), refunded: usdc("1000000", "1.000000"), refund_type: "INTENTS", refund_to: "acme-store.near" });
    const fresh = quote({ id: "iq_2", deposit_address: "0x1111111111111111111111111111111111111111" });
    const createIntentsQuote = vi.fn(async () => fresh);
    const api = { intentsQuote: vi.fn(), createIntentsQuote, simulateIntentsDeposit: vi.fn(), submitIntentsDeposit: vi.fn() } as never;
    wrap(<AnyChainPanel view={view({ active_quote: returned })} api={api} streaming options={options([option(BASE_USDC), option(ETH_USDC)])} onRefresh={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Your deposit was returned" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Network" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("0x1111111111111111111111111111111111111111")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Your deposit was returned" })).toBeNull();
  });

  it("says a returned deposit goes to the business when the buyer gave no address", () => {
    wrap(<AnyChainPanel view={view({ active_quote: quote({ refund_type: "INTENTS", refund_to: "acme-store.near" }) })} api={checkoutApi} streaming options={options([option(BASE_USDC)])} onRefresh={() => undefined} />);
    expect(screen.getByText("If a payment cannot complete (too little, or too late), NEAR Intents returns it to Acme Store's account acme-store.near, and Acme Store sends it back to you.")).toBeInTheDocument();
  });
});

describe("the test-money badge next to the business name", () => {
  const sandbox = () => {
    const qc = new QueryClient();
    qc.setQueryData(["checkout-info"], { network: { id: "near:sandbox" } });
    return qc;
  };
  it("is hidden when the payment is live, even on a local sandbox", () => {
    wrap(<MerchantRow merchant={{ name: "Acme Store" }} livemode />, sandbox());
    expect(screen.queryByText("Local sandbox")).toBeNull();
  });
  it("still says Local sandbox for test money", () => {
    wrap(<MerchantRow merchant={{ name: "Acme Store" }} livemode={false} />, sandbox());
    expect(screen.getByText("Local sandbox")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const BASE_DEST: IntentsDestinationOption = { chain: "base", chain_name: "Base", symbol: "USDC", asset: BASE_USDC.asset, decimals: 6, verify: "provider_only" };
const NEAR_DEST: IntentsDestinationOption = { chain: "near", chain_name: "NEAR", symbol: "USDC", asset: "nep141:usdc.near", decimals: 6, verify: "rpc" };
const payout = (over: Partial<IntentsPayout> = {}): IntentsPayout => ({
  object: "intents_payout",
  mode: "live",
  label: "Live - NEAR mainnet",
  settlement_network: "near:mainnet",
  account: "acme-store.near",
  verified: true,
  checks: { exists: true, usdc_registered: true, proven: true, proven_at: "2026-11-10T00:00:00Z" },
  usdc: { contract: "usdc.near", asset_id: "nep141:usdc.near", decimals: 6 },
  storage_step: null,
  enabled: true,
  proof_scope: { settlement_network: "near:mainnet", hub: "hub.payminto.near" },
  checked_at: "2026-11-10T00:00:00Z",
  default_origin: null,
  destination: null,
  destinations: [BASE_DEST, NEAR_DEST],
  ...over,
});

const hexText = (hex: string) => new TextDecoder().decode(Uint8Array.from(hex.slice(2).match(/../g)!.map((b) => parseInt(b, 16))));

describe("Receive as", () => {
  it("lists USDC on NEAR first and says plainly where NEAR Intents' report is the only confirmation", () => {
    const onChoose = vi.fn();
    wrap(<ReceiveAs p={payout()} value="near" onChange={onChoose} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["USDC on NEAR", "USDC on Base"]);
    expect(screen.getByText("Deliveries to Base are confirmed by NEAR Intents' report. This server cannot read Base itself.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "USDC on Base" }));
    expect(onChoose).toHaveBeenCalledWith("base");
  });
});

describe("an EVM payout address: connect, then sign, each from its own click", () => {
  let request: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    request = vi.fn(async ({ method }: { method: string; params?: unknown[] }) => {
      if (method === "eth_requestAccounts") return [PAYOUT_EVM.toLowerCase()];
      if (method === "personal_sign") return `0x${"11".repeat(65)}`;
      throw new Error(`unexpected ${method}`);
    });
    (window as unknown as { ethereum?: unknown }).ethereum = { request };
  });
  afterEach(() => {
    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  function renderForm(walletTimeoutMs?: number) {
    const onSaved = vi.fn();
    wrap(<EvmPayoutForm p={payout()} merchantId="mer_1" destination={BASE_DEST} onSaved={onSaved} onCancel={null} {...(walletTimeoutMs ? { walletTimeoutMs } : {})} />);
    fireEvent.change(screen.getByLabelText("Your address on Base"), { target: { value: PAYOUT_EVM } });
    return onSaved;
  }

  it("connects, signs the exact message, then saves the address with its EIP-191 proof", async () => {
    setIntentsPayout.mockImplementation(async () => payout({ destination: { ...BASE_DEST, address: PAYOUT_EVM.toLowerCase(), proven: true } }));
    const onSaved = renderForm();
    expect(screen.getByText(/Deliveries to Base are confirmed by NEAR Intents' report/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: "Sign the message" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    fireEvent.click(screen.getByRole("button", { name: "Sign the message" }));
    await screen.findByText(/Signed by/);
    const [hex, signer] = request.mock.calls[1]![0].params as [string, string];
    const message = hexText(hex);
    expect(message).toMatch(/^Payminto intents payout mer_1 0xab12cd34ef56ab12cd34ef56ab12cd34ef56abcd \d+ network eip155:8453 hub hub\.payminto\.near$/);
    expect(signer).toBe(PAYOUT_EVM.toLowerCase());
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const timestamp = Number(message.split(" ")[5]);
    expect(setIntentsPayout).toHaveBeenCalledWith({ destination_chain: "base", address: PAYOUT_EVM.toLowerCase(), proof: { type: "eip191", timestamp, signature: `0x${"11".repeat(65)}` } });
  });

  it("refuses a wallet connected as another address, and signs nothing", async () => {
    request.mockImplementation(async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? ["0x0000000000000000000000000000000000000001"] : "0x"));
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByText(/Your wallet is connected as 0x0000...0001/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign the message" })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a wallet that never answers ends in a plain message and a way to try again", async () => {
    request.mockImplementation(async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? [PAYOUT_EVM] : new Promise(() => undefined)));
    renderForm(30);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign the message" }));
    expect(await screen.findByText(/Your wallet did not answer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign the message" })).toBeEnabled();
  });

  it("says so when the browser has no wallet", async () => {
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByText(/No browser wallet found/)).toBeInTheDocument();
  });
});

describe("Token customers see first", () => {
  it("saves the chosen origin with PATCH", async () => {
    setIntentsDefaultOrigin.mockImplementation(async (v: string | null) => payout({ default_origin: v }));
    const onSaved = vi.fn();
    // jsdom lacks the pointer capture and scrolling the select's menu uses.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
    wrap(<DefaultOriginField p={payout()} onSaved={onSaved} />);
    const trigger = screen.getByRole("combobox", { name: "Token customers see first" });
    expect(trigger).toHaveTextContent("No preference");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = await screen.findByRole("listbox");
    expect(within(menu).getAllByRole("option").map((o) => o.textContent)).toContain("ETH on Base");
    await act(async () => {
      fireEvent.click(within(menu).getByRole("option", { name: "USDC on Base" }));
    });
    await waitFor(() => expect(setIntentsDefaultOrigin).toHaveBeenCalledWith(BASE_USDC.asset));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe("paying the deposit from a browser wallet", () => {
  const HASH = `0x${"cd".repeat(32)}`;
  const FROM = "0x1111111111111111111111111111111111111111";
  let sent: unknown[] = [];
  let usdcHeld = 30_000_000n;
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) =>
      method === "eth_requestAccounts" ? [FROM] : method === "eth_chainId" ? "0x2105" : method === "eth_call" ? `0x${usdcHeld.toString(16)}` : method === "eth_sendTransaction" ? (sent.push(params), HASH) : null,
  };
  const live = (over: Record<string, unknown> = {}) => quote({ mode: "live", label: "Live - NEAR mainnet", ...over });

  beforeEach(() => {
    sent = [];
    usdcHeld = 30_000_000n;
    setEvmProvider(provider);
  });
  afterEach(() => setEvmProvider(null));

  it("is the first way to pay on a live deposit: one press sends the exact transfer and tells the server its hash", async () => {
    const submit = vi.fn(async () => live({ status: "processing" }));
    const api = { intentsQuote: vi.fn(), createIntentsQuote: vi.fn(), simulateIntentsDeposit: vi.fn(), submitIntentsDeposit: submit } as never;
    wrap(<AnyChainPanel view={view({ mode: "live", active_quote: live() })} api={api} streaming options={options([])} onRefresh={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay 25.025 USDC with your wallet" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("pay_1", "iq_1", HASH));
    expect(sent).toEqual([[{ from: FROM, to: BASE_USDC.contract_address, value: "0x0", data: `0xa9059cbb${DEPOSIT.slice(2).padStart(64, "0")}${(25025000).toString(16).padStart(64, "0")}` }]]);
  });

  it("says the wallet holds too little before the wallet opens, and sends nothing", async () => {
    usdcHeld = 0n;
    const submit = vi.fn();
    const api = { intentsQuote: vi.fn(), createIntentsQuote: vi.fn(), simulateIntentsDeposit: vi.fn(), submitIntentsDeposit: submit } as never;
    wrap(<AnyChainPanel view={view({ mode: "live", active_quote: live() })} api={api} streaming options={options([])} onRefresh={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay 25.025 USDC with your wallet" }));
    expect(await screen.findByText(/holds 0 USDC on Base, and this payment needs 25\.025 USDC/)).toBeInTheDocument();
    expect(sent).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("is never offered for simulated money, where the address is not real", () => {
    wrap(<AnyChainPanel view={view({ active_quote: quote() })} api={checkoutApi} streaming options={options([])} onRefresh={() => undefined} />);
    expect(screen.queryByRole("button", { name: /with your wallet/ })).toBeNull();
  });
});

describe("a payment link opens its checkout at once when it asks for nothing", () => {
  it("does for a fixed amount with no email or name, and not otherwise", () => {
    const base = { active: true, amount: "5000000", collect_email: false, collect_name: false };
    expect(linkOpensCheckout(base)).toBe(true);
    expect(linkOpensCheckout({ ...base, amount: null })).toBe(false);
    expect(linkOpensCheckout({ ...base, collect_email: true })).toBe(false);
    expect(linkOpensCheckout({ ...base, collect_name: true })).toBe(false);
    expect(linkOpensCheckout({ ...base, active: false })).toBe(false);
  });
});
