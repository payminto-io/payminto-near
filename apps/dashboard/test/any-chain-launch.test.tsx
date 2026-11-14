import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@/lib/http";
import { checkoutModel } from "@/lib/checkout";
import { WALLET_HELD } from "@/lib/intents";
import { intentsQuoteSchema, paymentDetailSchema, type CheckoutView, type IntentsQuote, type PaymentDetail } from "@/lib/schemas";

// The dashboard hooks these components read: the signed-in API, the role, the token and the explorer.
const createRefund = vi.fn();
let canIssue = true;
vi.mock("@/lib/session", () => ({ useApi: () => ({ gateway: { createRefund } }), useCan: () => (p: string) => (p === "refunds.issue" ? canIssue : true) }));
vi.mock("@/lib/queries", () => ({
  useToken: () => ({ symbol: "USDC", decimals: 6 }),
  useExplorer: () => ({ tx: (h: string) => `https://testnet.explorer.test/txns/${h}`, address: (a: string) => `https://testnet.explorer.test/address/${a}` }),
}));

import { MethodsEditor, type MethodRow } from "@/components/operator/methods-editor";
import { RefundDialog } from "@/components/gateway/refund-dialog";
import { CheckoutPanel } from "@/components/checkout/checkout";
import { IntentsCard } from "@/components/gateway/intents-card";

const BUYER = "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f";
const DEPOSIT_TX = `0x${"ab".repeat(32)}`;
const REFUND_TX = `0x${"cd".repeat(32)}`;
const NOW = Date.parse("2026-11-12T10:00:00Z");

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function quote(over: Partial<IntentsQuote> = {}): IntentsQuote {
  return intentsQuoteSchema.parse({
    id: "iq_1",
    object: "intents_quote",
    payment_id: "pay_1",
    mode: "live",
    label: "Live - NEAR mainnet",
    status: "confirmed",
    provider_status: "SUCCESS",
    origin: { asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6 },
    deposit_address: "0x87151c5ac911a4459762ce215649313cd369dc05",
    deposit_memo: null,
    send_exactly: { amount: "25025000", formatted: "25.025000", symbol: "USDC" },
    min_amount_in: { amount: "25020000", formatted: "25.020000", symbol: "USDC" },
    amount_out: { amount: "25000000", formatted: "25.000000", symbol: "USDC" },
    amount_in_usd: "25.02",
    fees: {
      send_exactly: { amount: "25025000", formatted: "25.025000", symbol: "USDC" },
      merchant_receives: { amount: "25000000", formatted: "25.000000", symbol: "USDC" },
      swap_cost: { amount: "5080", formatted: "0.005080", unit: "USDC" },
      price_buffer: { amount: "20000", formatted: "0.020000", symbol: "USDC" },
      refund_fee: { amount: "2402", formatted: "0.002402", symbol: "USDC" },
      delivery_fee: null,
      time_estimate_sec: 35,
    },
    slippage_bps: 10,
    time_estimate_sec: 35,
    refund_to: BUYER,
    recipient: "acme-store.near",
    settlement_network: "near:mainnet",
    deadline: "2026-11-12T10:30:00.000Z",
    deadline_passed: false,
    inactive_at: "2026-11-12T10:30:00.000Z",
    deposited: { amount: "25025000", formatted: "25.025000", symbol: "USDC" },
    delivered: { amount: "25000000", formatted: "25.000000", symbol: "USDC" },
    refunded: null,
    refund_reason: null,
    origin_txs: [{ hash: DEPOSIT_TX, explorer_url: `https://basescan.org/tx/${DEPOSIT_TX}` }],
    destination_txs: [],
    near_txs: [],
    delivery_tx: null,
    verification: "rpc_checked",
    steps: [
      { key: "waiting", label: "Waiting for deposit", state: "done" },
      { key: "received", label: "Deposit received", state: "done" },
      { key: "converting", label: "Converting to USDC", state: "done" },
      { key: "delivered", label: "Delivered to merchant", state: "done" },
    ],
    warning: "Send only USDC on the Base network, to this address.",
    correlation_id: "0f8b2c1e",
    signature_valid: true,
    created_at: "2026-11-12T09:58:00.000Z",
    updated_at: "2026-11-12T10:00:00.000Z",
    ...over,
  });
}

function payment(over: Record<string, unknown> = {}): PaymentDetail {
  return paymentDetailSchema.parse({
    id: "pay_1",
    livemode: true,
    status: "paid",
    amount: "25000000",
    amount_due: "25000000",
    net_amount: "25000000",
    amount_paid: "25000000",
    amount_refunded: "0",
    refund_status: "none",
    token: "usdc.near",
    method: "oneclick",
    payer: `base:${BUYER}`,
    order_hash: "ab".repeat(32),
    checkout_url: "https://pay.example/pay/pay_1",
    late: false,
    expires_at: "2026-11-12T11:00:00Z",
    created_at: "2026-11-12T09:50:00Z",
    refunds: [],
    intents: { mode: "live", label: "Live - NEAR mainnet", quotes: [quote()] },
    ...over,
  });
}

beforeEach(() => {
  createRefund.mockReset();
  canIssue = true;
  // jsdom has no media queries; the checkout's motion asks for prefers-reduced-motion.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })) as never;
});

describe("settings: a method locked in live mode (Q2)", () => {
  const rows: MethodRow[] = [
    { method: "wallet", enabled: false, fee_bps: 0, fee_fixed: "0", bearer: "merchant", min_amount: null, max_amount: null, locked_reason: "Off in live mode: this method pays test money." },
    { method: "voucher", enabled: true, fee_bps: 0, fee_fixed: "0", bearer: "merchant", min_amount: null, max_amount: null, locked_reason: null },
  ];
  it("disables the locked switch and says why under it", () => {
    const onChange = vi.fn();
    render(<MethodsEditor rows={rows} onChange={onChange} editableFees={false} />);
    const wallet = screen.getByRole("switch", { name: "Pay with a NEAR wallet" });
    expect(wallet).toBeDisabled();
    expect(wallet).toHaveAccessibleDescription("Off in live mode: this method pays test money.");
    expect(screen.getByRole("switch", { name: "AI agent with a Budget" })).toBeEnabled();
    fireEvent.click(wallet);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("refunding a payment that came from another chain (Q1)", () => {
  it("shows the buyer's address, chain, token, deposit and refundable amount instead of a NEAR transfer", () => {
    wrap(<RefundDialog payment={payment()} merchant={undefined} open onOpenChange={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("This payment came from another chain")).toBeInTheDocument();
    expect(within(dialog).getByText(BUYER)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    expect(within(dialog).getByText("USDC on Base")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /opens the explorer/ })).toHaveAttribute("href", `https://basescan.org/tx/${DEPOSIT_TX}`);
    expect(within(dialog).queryByText(/NEAR from your payout account/)).toBeNull();
    expect(within(dialog).queryByLabelText("Send to")).toBeNull();
  });

  it("checks the hash on that chain, then records the refund with `manual`", async () => {
    createRefund.mockResolvedValue({});
    const onOpenChange = vi.fn();
    wrap(<RefundDialog payment={payment()} merchant={undefined} open onOpenChange={onOpenChange} />);
    const hash = screen.getByLabelText("Transaction hash on Base");
    fireEvent.change(hash, { target: { value: "0x123" } });
    expect(screen.getByText("That is not a Base transaction hash. It is 0x followed by 64 characters, 0 to 9 and a to f.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record refund of 25.00 USDC" }));
    expect(createRefund).not.toHaveBeenCalled();
    fireEvent.change(hash, { target: { value: REFUND_TX } });
    fireEvent.change(screen.getByLabelText("Amount refunded"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/Internal note/), { target: { value: "Ticket 42" } });
    fireEvent.click(screen.getByRole("button", { name: "Record refund of 10.00 USDC" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(createRefund).toHaveBeenCalledWith({ paymentId: "pay_1", amount: "10000000", reason: "Requested by customer", note: "Ticket 42", manual: { chain: "base", tx_hash: REFUND_TX } }, expect.any(String));
  });

  it("switches to the manual form when the node answers 409 REFUND_MANUAL_REQUIRED to a NEAR refund", async () => {
    const details = { chain: "sol", chain_name: "Solana", symbol: "USDC", refund_to: "So11111111111111111111111111111111111111112", deposit_tx: null, refundable: "25000000" };
    createRefund.mockRejectedValueOnce(new ApiError(409, "REFUND_MANUAL_REQUIRED", "Send it by hand.", details));
    // An older payment view: nothing on it says the money came from another chain.
    const p = payment({ method: "wallet", payer: "alice.near", intents: null });
    const merchant = { payout: "acme-store.near", token: "usdc.near" } as never;
    wrap(<RefundDialog payment={p} merchant={merchant} open onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Refund 25.00 USDC" }));
    expect(await screen.findByText("This payment came from another chain")).toBeInTheDocument();
    expect(screen.getByText("So11111111111111111111111111111111111111112")).toBeInTheDocument();
    expect(screen.getByLabelText("Transaction hash on Solana")).toBeInTheDocument();
  });

  it("shows Staff the details but leaves recording to an Admin", () => {
    canIssue = false;
    wrap(<RefundDialog payment={payment()} merchant={undefined} open onOpenChange={() => undefined} />);
    expect(screen.getByText(BUYER)).toBeInTheDocument();
    expect(screen.getByText(/An Admin sends this refund/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record refund/ })).toBeNull();
  });
});

describe("the checkout's pay panel", () => {
  function view(over: Partial<CheckoutView> = {}): CheckoutView {
    return {
      id: "pay_1",
      livemode: true,
      status: "open",
      late: false,
      merchant: { name: "Acme Store", support_email: "help@acme.example" },
      description: "Pro plan",
      reference: null,
      amount: "25000000",
      surcharge: "0",
      amount_due: "25000000",
      amount_paid: "0",
      amount_remaining: "25000000",
      network: "near:testnet",
      token: { address: "usdc.test.near", symbol: "USDC", decimals: 6 },
      hub: "hub.test.near",
      method: "oneclick",
      methods: ["oneclick"],
      wallet: null,
      success_url: null,
      order_hash: "ab".repeat(32),
      expires_at: "2026-11-12T11:00:00Z",
      created_at: "2026-11-12T09:50:00Z",
      intents: { mode: "live", label: "Live - NEAR mainnet", available: true, reason: null, settlement_network: "near:mainnet", active_quote: null },
      ...over,
    } as CheckoutView;
  }
  const api = { intentsOptions: vi.fn(), intentsQuote: vi.fn(), addEmail: vi.fn(), order: vi.fn() } as never;
  const options = { data: { options: [] }, isPending: false, isError: false, refetch: vi.fn() } as never;
  const panel = (v: CheckoutView, over: Record<string, unknown>) => (
    <CheckoutPanel
      view={v}
      api={api}
      live="live"
      model={checkoutModel(v, { now: NOW, signing: false })}
      methods={[]}
      active={null}
      quote={null}
      tabs={["oneclick"]}
      tab="oneclick"
      anyChain
      options={options}
      onPick={() => undefined}
      held={false}
      step="idle"
      setStep={() => undefined}
      refresh={() => undefined}
      hasWallet
      watched={false}
      {...over}
    />
  );

  it("offers Any chain alone without a tab bar in live mode (Q2)", () => {
    wrap(panel(view(), {}));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("heading", { name: "Pay with" })).toBeInTheDocument();
  });

  it("keeps the NEAR wallet tab while a deposit is on its way, with a notice and no Pay button (A5)", () => {
    const v = view({ methods: ["wallet", "oneclick"], intents: { ...view().intents!, active_quote: quote({ status: "processing", delivered: null }) } });
    wrap(panel(v, { tabs: ["wallet", "oneclick"], tab: "wallet", held: true, active: "wallet" }));
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByText(WALLET_HELD)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pay/ })).toBeNull();
  });
});

describe("the excess 1Click returned on a paid payment (B2)", () => {
  const excess = quote({ refunded: { amount: "20000", formatted: "0.020000", symbol: "USDC" } });
  it("shows the buyer what came back and where on the receipt", () => {
    const v = {
      ...payment(),
      livemode: true,
      late: false,
      merchant: { name: "Acme Store" },
      surcharge: "0",
      amount_remaining: "0",
      token: { address: "usdc.near", symbol: "USDC", decimals: 6 },
      hub: "hub.test.near",
      methods: ["oneclick"],
      wallet: null,
      paid_at: "2026-11-12T10:00:00Z",
      intents: { mode: "live", label: "Live - NEAR mainnet", available: false, reason: null, settlement_network: "near:mainnet", active_quote: excess },
    } as unknown as CheckoutView;
    wrap(
      <CheckoutPanel
        view={v}
        api={{} as never}
        live="live"
        model={checkoutModel(v, { now: NOW, signing: false })}
        methods={[]}
        active={null}
        quote={null}
        tabs={[]}
        tab={null}
        anyChain={false}
        options={{} as never}
        onPick={() => undefined}
        held={false}
        step="idle"
        setStep={() => undefined}
        refresh={() => undefined}
        hasWallet
        watched={false}
      />,
    );
    const row = screen.getByText("Returned to you").closest("div")!;
    expect(within(row).getByText("0.02 USDC")).toBeInTheDocument();
    expect(within(row).getByText(BUYER)).toBeInTheDocument();
  });
  it("calls it an excess for the business, never a refund", () => {
    wrap(<IntentsCard intents={{ mode: "live", label: "Live - NEAR mainnet", quotes: [excess] }} />);
    expect(screen.getByText("Excess returned to the buyer")).toBeInTheDocument();
    expect(screen.queryByText("Returned to buyer")).toBeNull();
  });
});
