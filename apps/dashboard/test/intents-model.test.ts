import { describe, expect, it } from "vitest";
import {
  activeQuote,
  amountText,
  anyChainMethodLabel,
  anyChainOffered,
  clockUtc,
  deadlineModel,
  enableErrorText,
  approxUnits,
  exactUnits,
  expiredCopy,
  failedCopy,
  incompleteCopy,
  inFlight,
  initialTab,
  intentsAnnouncement,
  intentsStage,
  linkPayCopy,
  mainnetTxUrl,
  originPayer,
  showsAnyChain,
  paidFromText,
  payoutChecklist,
  payTabs,
  refundAddressProblem,
  refundKept,
  refundReasonText,
  returnedCopy,
  sendNow,
  shortAmount,
  showsDeposit,
  timeEstimateText,
  unitsOf,
  verificationText,
  depositFeeLines,
  depositOnItsWay,
  excessReturned,
  isInFlightError,
  manualRefundFromError,
  manualRefundOf,
  originTxProblem,
  returnedLabel,
  showsTabBar,
  WALLET_HELD,
  wrongDepositCopy,
} from "@/lib/intents";
import { ApiError } from "@/lib/http";
import { checkoutViewSchema, intentsPayoutSchema, intentsQuoteSchema, type CheckoutView, type IntentsQuote, type IntentsQuoteStatus } from "@/lib/schemas";

const NOW = Date.parse("2026-11-10T22:08:01.512Z");
const BASE_USDC = { asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6 };
const SOL_USDC = { asset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", chain: "sol", chain_name: "Solana", symbol: "USDC", decimals: 6 };

/** The deposit screen JSON of docs/DEVELOPERS.md, "Any-chain checkout". */
function quote(over: Partial<IntentsQuote> = {}): IntentsQuote {
  return intentsQuoteSchema.parse({
    id: "iq_ccbq7ktq3ypx2m3l3wmbqcbb",
    object: "intents_quote",
    payment_id: "pay_boxykimcem2hjper3q3nb53l",
    mode: "simulated",
    label: "Simulated - no real money",
    status: "awaiting_deposit",
    provider_status: null,
    origin: BASE_USDC,
    deposit_address: "0x87151c5ac911a4459762ce215649313cd369dc05",
    deposit_memo: null,
    send_exactly: { amount: "4509585", formatted: "4.509585", symbol: "USDC" },
    min_amount_in: { amount: "4505080", formatted: "4.505080", symbol: "USDC" },
    amount_out: { amount: "4500000", formatted: "4.500000", symbol: "USDC" },
    amount_in_usd: "4.507570845505",
    fees: {
      send_exactly: { amount: "4509585", formatted: "4.509585", symbol: "USDC" },
      merchant_receives: { amount: "4500000", formatted: "4.500000", symbol: "USDC" },
      swap_cost: { amount: "5080", formatted: "0.005080", unit: "USDC" },
      price_buffer: { amount: "4505", formatted: "0.004505", symbol: "USDC" },
      refund_fee: { amount: "2402", formatted: "0.002402", symbol: "USDC" },
      delivery_fee: { amount: "4628", formatted: "0.004628", symbol: "USDC" },
      time_estimate_sec: 35,
    },
    slippage_bps: 10,
    time_estimate_sec: 35,
    refund_to: "0x5f2b...554f",
    recipient: "anychain.test.near",
    settlement_network: "near:mainnet (simulated)",
    deadline: "2026-11-10T22:38:01.000Z",
    deadline_passed: false,
    inactive_at: "2026-11-10T22:38:01.000Z",
    deposited: null,
    delivered: null,
    refunded: null,
    refund_reason: null,
    origin_txs: [],
    destination_txs: [],
    near_txs: [],
    delivery_tx: null,
    verification: null,
    steps: [
      { key: "waiting", label: "Waiting for deposit", state: "current" },
      { key: "received", label: "Deposit received", state: "pending" },
      { key: "converting", label: "Converting to USDC", state: "pending" },
      { key: "delivered", label: "Delivered to merchant", state: "pending" },
    ],
    warning: "Send only USDC on the Base network, to this address. Other tokens, other networks, or a deposit after 22:38 UTC may be lost.",
    correlation_id: "0f8b2c1e-6a43-4c1b-9d61-3f0c8f0d2a77",
    signature_valid: true,
    created_at: "2026-11-10T22:08:01.512Z",
    updated_at: "2026-11-10T22:08:01.512Z",
    ...over,
  });
}

function view(over: Partial<CheckoutView> = {}): Pick<CheckoutView, "id" | "merchant" | "methods" | "intents"> {
  return {
    id: "pay_boxykimcem2hjper3q3nb53l",
    merchant: { name: "Northwind Coffee", support_email: "hello@northwind.example" },
    methods: ["wallet", "oneclick"],
    intents: { mode: "simulated", label: "Simulated - no real money", available: true, reason: null, settlement_network: "near:mainnet (simulated)", active_quote: null },
    ...over,
  };
}

describe("the documented JSON parses", () => {
  it("a checkout view with intents, and one from a node without them", () => {
    const base = {
      id: "pay_1",
      livemode: false,
      status: "open",
      merchant: { name: "Northwind Coffee" },
      amount: "4500000",
      amount_due: "4500000",
      amount_paid: "0",
      amount_remaining: "4500000",
      token: { address: "usdc.test.near", symbol: "USDC", decimals: 6 },
      hub: "hub.test.near",
      methods: ["wallet", "oneclick"],
      order_hash: "ab".repeat(32),
      expires_at: "2026-11-10T23:00:00Z",
      created_at: "2026-11-10T22:00:00Z",
    };
    expect(checkoutViewSchema.parse({ ...base, intents: view().intents }).intents?.available).toBe(true);
    expect(checkoutViewSchema.parse({ ...base, methods: ["wallet"] }).intents).toBeNull();
  });
  it("the business's account and its storage step", () => {
    const p = intentsPayoutSchema.parse({
      object: "intents_payout",
      mode: "simulated",
      label: "Simulated - no real money",
      settlement_network: "near:mainnet (simulated)",
      account: "anychain.test.near",
      verified: false,
      checks: { exists: true, usdc_registered: false, proven: true, proven_at: "2026-11-10T22:01:12.044Z" },
      usdc: { contract: "usdc.test.near", asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
      storage_step: {
        why: "anychain.test.near is not registered with USDC yet.",
        deposit_near: "0.00125",
        transaction: { receiverId: "usdc.test.near", actions: [{ type: "FunctionCall", params: { methodName: "storage_deposit", args: { account_id: "anychain.test.near", registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" } }] },
      },
      enabled: false,
      proof_scope: { settlement_network: "near:mainnet (simulated)", hub: "hub.test.near" },
      checked_at: "2026-11-10T22:01:12.101Z",
    });
    expect(payoutChecklist(p).map((c) => [c.key, c.state])).toEqual([
      ["exists", "done"],
      ["usdc", "failed"],
      ["proven", "done"],
    ]);
  });
});

describe("tabs: the NEAR wallet first, then Any chain when offered", () => {
  it("offers Any chain only when the methods list it and the node says it is available", () => {
    expect(anyChainOffered(view())).toBe(true);
    expect(anyChainOffered(view({ methods: ["wallet"] }))).toBe(false);
    expect(anyChainOffered(view({ intents: { ...view().intents!, available: false, reason: "This checkout expires too soon to pay from another chain." } }))).toBe(false);
    expect(anyChainOffered(view({ intents: null }))).toBe(false);
  });
  it("keeps the wallet first and opens on it", () => {
    expect(payTabs(view(), true)).toEqual(["wallet", "oneclick"]);
    expect(initialTab(view(), true)).toBe("wallet");
    expect(payTabs(view({ methods: ["wallet"] }), true)).toEqual(["wallet"]);
  });
  it("opens on Any chain when a deposit address of this payment is in use, even after it stopped taking new ones", () => {
    const busy = view({ methods: [], intents: { ...view().intents!, available: false, active_quote: quote({ status: "processing" }) } });
    expect(payTabs(busy, false)).toEqual(["oneclick"]);
    expect(initialTab(busy, false)).toBe("oneclick");
    expect(activeQuote(view({ intents: { ...view().intents!, active_quote: quote({ status: "expired" }) } }))).toBeNull();
  });
});

describe("intentsStage: which screen a deposit address shows", () => {
  const cases: [IntentsQuoteStatus, boolean, string][] = [
    ["awaiting_deposit", false, "deposit"],
    ["awaiting_deposit", true, "expired"],
    ["deposit_detected", false, "deposit"],
    ["processing", true, "deposit"],
    ["delivered", false, "deposit"],
    ["incomplete_deposit", false, "incomplete"],
    ["confirmed", false, "done"],
    ["refunded", false, "returned"],
    ["failed", false, "failed"],
    ["expired", true, "expired"],
  ];
  it.each(cases)("%s (deadline passed %s) is %s", (status, passed, stage) => {
    expect(intentsStage({ status, deadline_passed: passed })).toBe(stage);
  });
  it("keeps the deposit screen while money is on its way", () => {
    expect(showsDeposit(quote())).toBe(true);
    expect(inFlight(quote())).toBe(false);
    expect(inFlight(quote({ status: "deposit_detected" }))).toBe(true);
    expect(showsDeposit(quote({ status: "confirmed" }))).toBe(false);
    expect(showsDeposit(null)).toBe(false);
  });
});

describe("amounts: exact, without padding zeros", () => {
  it("drops only trailing zeros and keeps two places", () => {
    expect(exactUnits("4.500000")).toBe("4.50");
    expect(exactUnits("4.509585")).toBe("4.509585");
    expect(exactUnits("0.002441510000000000")).toBe("0.00244151");
    expect(exactUnits("5")).toBe("5.00");
  });

  it("rounds an indicative amount to what a person reads: 6 places from 1 up, 4 significant digits below 1", () => {
    expect(approxUnits("0.000977882374124212")).toBe("0.0009779");
    expect(approxUnits("0.000977849999999999")).toBe("0.0009778");
    expect(approxUnits("2.006834")).toBe("2.006834");
    expect(approxUnits("2.0068345")).toBe("2.006835");
    expect(approxUnits("0.999999999")).toBe("1.00");
    expect(approxUnits("12.500000")).toBe("12.50");
    expect(approxUnits("0.5")).toBe("0.50");
    expect(approxUnits("not a number")).toBe("not a number");
    expect(amountText({ formatted: "5.010154", symbol: "USDC" })).toBe("5.010154 USDC");
    expect(unitsOf(2010154n, 6)).toBe("2.010154");
    expect(unitsOf(5n, 6)).toBe("0.000005");
  });
  it("says 1Click's time estimate as one", () => {
    expect(timeEstimateText(35)).toBe("under a minute");
    expect(timeEstimateText(60)).toBe("about a minute");
    expect(timeEstimateText(807)).toBe("about 14 minutes");
    expect(timeEstimateText(7200)).toBe("about 2 hours");
    expect(timeEstimateText(null)).toBeNull();
  });
});

describe("the deposit screen's countdown is the address's deadline", () => {
  it("counts down to deadline in the clock the warning uses", () => {
    const d = deadlineModel(quote(), NOW);
    expect(d.text).toBe("29:59");
    expect(d.clock).toBe("22:38 UTC");
    expect(d.tone).toBe("neutral");
    expect(d.fraction).toBeGreaterThan(0.99);
    expect(deadlineModel(quote(), Date.parse("2026-11-10T22:37:30Z")).tone).toBe("danger");
    expect(clockUtc("not a time")).toBe("");
  });
});

describe("screen E copy, exactly as designed", () => {
  it("incomplete: received, remaining, deadline, refund address", () => {
    const q = quote({ status: "incomplete_deposit", send_exactly: { amount: "5010154", formatted: "5.010154", symbol: "USDC" }, deposited: { amount: "3000000", formatted: "3.000000", symbol: "USDC" }, refund_to: "0x12...ab", deadline: "2026-11-10T15:49:00.000Z" });
    expect(incompleteCopy(q)).toBe("We received 3.00 of 5.010154 USDC. Send the remaining 2.010154 USDC to the same address before 15:49 UTC, or it will be returned to 0x12...ab.");
  });
  it("the amount to send now: the full amount first, only what is missing after a short deposit", () => {
    expect(sendNow(quote())).toEqual({ amount: "4.509585", symbol: "USDC", remaining: false });
    const short = quote({ status: "incomplete_deposit", send_exactly: { amount: "5010154", formatted: "5.010154", symbol: "USDC" }, deposited: { amount: "3000000", formatted: "3.000000", symbol: "USDC" } });
    expect(sendNow(short)).toEqual({ amount: "2.010154", symbol: "USDC", remaining: true });
    // More than enough already arrived: nothing is left to send, so the screen never asks for zero or a negative amount.
    expect(sendNow({ ...short, deposited: { amount: "6000000", formatted: "6.000000", symbol: "USDC" } })).toEqual({ amount: "5.010154", symbol: "USDC", remaining: false });
  });
  it("returned: amount, address, chain and the reason in plain words", () => {
    const q = quote({ status: "refunded", refunded: { amount: "4997600", formatted: "4.997600", symbol: "USDC" }, refund_to: "0x12...ab", refund_reason: "PARTIAL_DEPOSIT" });
    // The screen's heading already says "Your deposit was returned", so the line under it does not say it again.
    expect(returnedCopy(q)).toBe("4.9976 USDC went back to 0x12...ab on Base, because the deposit was below the required amount.");
    expect(returnedCopy({ ...q, refunded: null, refund_reason: null })).toBe("It went back to 0x12...ab on Base.");
    expect(refundReasonText("SOMETHING_NEW")).toBe("1Click reported SOMETHING_NEW");
    // The live region has no heading, so it says it in full.
    expect(intentsAnnouncement(q)).toBe("Your deposit was returned. 4.9976 USDC went back to 0x12...ab on Base, because the deposit was below the required amount.");
  });
  it("returned: what NEAR Intents kept, so sent and returned add up", () => {
    const q = quote({ status: "refunded", deposited: { amount: "1204100", formatted: "1.204100", symbol: "USDC" }, refunded: { amount: "1194090", formatted: "1.194090", symbol: "USDC" } });
    expect(refundKept(q)).toBe("0.01001 USDC");
    expect(refundKept({ ...q, refunded: null })).toBeNull();
    expect(refundKept({ ...q, refunded: { amount: "1204100", formatted: "1.204100", symbol: "USDC" } })).toBeNull();
  });
  it("failed: who to contact and the reference", () => {
    expect(failedCopy(view())).toBe("This payment could not be completed. Contact hello@northwind.example with reference pay_boxykimcem2hjper3q3nb53l.");
    expect(failedCopy({ ...view(), merchant: { name: "Northwind Coffee" } })).toContain("Contact Northwind Coffee with reference");
  });
  it("expired and done", () => {
    expect(expiredCopy(quote())).toContain("22:38 UTC");
    expect(paidFromText(quote())).toBe("Paid from Base through NEAR Intents");
  });
  it("never uses an em dash", () => {
    const all = [incompleteCopy(quote({ deposited: { amount: "1", formatted: "0.000001", symbol: "USDC" } })), returnedCopy(quote()), failedCopy(view()), expiredCopy(quote()), paidFromText(quote())];
    for (const s of all) expect(s).not.toMatch(/\u2014/);
  });
});

describe("refundAddressProblem: checked per chain before the button enables", () => {
  it("accepts an EVM address on Base and refuses the rest", () => {
    expect(refundAddressProblem(BASE_USDC, "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f")).toBeNull();
    expect(refundAddressProblem(BASE_USDC, "  0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f ")).toBeNull();
    expect(refundAddressProblem(BASE_USDC, "")).toBe("Enter your Base address.");
    expect(refundAddressProblem(BASE_USDC, "0x123")).toBe("That is not a Base address. It is 0x followed by 40 characters, 0 to 9 and a to f.");
    expect(refundAddressProblem(BASE_USDC, `0x${"0".repeat(40)}`)).not.toBeNull();
    expect(refundAddressProblem(BASE_USDC, "So11111111111111111111111111111111111111112")).not.toBeNull();
  });
  it("accepts a Solana address on Solana and refuses an EVM one and the system program", () => {
    expect(refundAddressProblem(SOL_USDC, "So11111111111111111111111111111111111111112")).toBeNull();
    expect(refundAddressProblem(SOL_USDC, "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f")).toContain("not a Solana address");
    expect(refundAddressProblem(SOL_USDC, "11111111111111111111111111111111")).not.toBeNull();
  });
});

describe("simulated mode", () => {
  it("sends too little: under the quote's minimum", () => {
    const q = quote();
    expect(BigInt(shortAmount(q))).toBeLessThan(BigInt(q.min_amount_in.amount));
    expect(shortAmount(q)).toBe("2705751");
  });
});

describe("the business's side", () => {
  it("names the method in lists from the paying quote, or from the payer's chain", () => {
    expect(anyChainMethodLabel({ method: "oneclick", payer: "base:0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f" }, [quote({ status: "confirmed" })])).toBe("Any chain - USDC on Base");
    expect(anyChainMethodLabel({ method: "oneclick", payer: "sol:So11111111111111111111111111111111111111112" })).toBe("Any chain - from Solana");
    expect(anyChainMethodLabel({ method: "oneclick", payer: null })).toBe("Any chain (NEAR Intents)");
    // A list item carries the node's summary of its quote, so lists name the token and chain without the detail.
    const summary = { mode: "simulated" as const, label: "Simulated - no real money", status: "awaiting_deposit" as const, origin: { asset: "nep141:eth.omft.near", chain: "eth", chain_name: "Ethereum", symbol: "ETH" } };
    expect(anyChainMethodLabel({ method: "oneclick", payer: null, intents: summary })).toBe("Any chain - ETH on Ethereum");
    expect(anyChainMethodLabel({ method: "oneclick", payer: "base:0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f", intents: null })).toBe("Any chain - from Base");
    expect(showsAnyChain({ method: "wallet", intents: summary })).toBe(true);
    expect(showsAnyChain({ method: "wallet", intents: null })).toBe(false);
    expect(originPayer("base:0xabc")).toEqual({ chain: "Base", address: "0xabc" });
    expect(originPayer("alice.testnet")).toBeNull();
  });
  it("says how the delivery was checked", () => {
    expect(verificationText("rpc_checked")).toBe("Delivery checked on NEAR");
    expect(verificationText("provider_only")).toBe("Reported by 1Click only");
    expect(verificationText(null)).toBe("Not delivered yet");
  });
  it("explains the 409s of turning the method on", () => {
    expect(enableErrorText("INTENTS_PAYOUT_REQUIRED", "x")).toContain("sign the message");
    expect(enableErrorText("INTENTS_PAYOUT_NOT_REGISTERED", "x")).toContain("storage deposit");
    expect(enableErrorText("OTHER", "as the server said")).toBe("as the server said");
  });
  it("lists every check as to do before an account is set", () => {
    const list = payoutChecklist({ account: null, settlement_network: "near:mainnet", checks: { exists: null, usdc_registered: null, proven: false, proven_at: null } });
    expect(list.map((c) => c.state)).toEqual(["todo", "todo", "todo"]);
    expect(list[0]!.label).toBe("The account exists on NEAR mainnet");
  });
  it("links a NEAR mainnet transaction to NearBlocks", () => {
    expect(mainnetTxUrl("8vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx")).toBe("https://nearblocks.io/txns/8vHxbKWRZtLJdD5Wmv4cCzQbYnU1ckqmVYp9oG6cWWLx");
  });
});

describe("the payment link page", () => {
  const offered = { mode: "simulated" as const, label: "Simulated - no real money", offered: true, reason: null };
  const live = { mode: "live" as const, label: "Live - NEAR mainnet", offered: true, reason: null };
  it("says the buyer pays from a NEAR wallet, or from another chain when the link offers it", () => {
    expect(linkPayCopy(null)).toEqual({ lead: "Next you pay from your NEAR wallet. A plain transfer from an exchange cannot carry this order, so it would not count as this payment.", chip: "Pay from your NEAR wallet", icon: "wallet" });
    expect(linkPayCopy({ ...offered, offered: false, reason: "This business does not take payments from other chains." }).chip).toBe("Pay from your NEAR wallet");
    const any = linkPayCopy(offered);
    expect(any.chip).toBe("Pay from NEAR or any chain");
    expect(any.icon).toBe("globe");
    expect(any.lead).toBe("Next you pay from your NEAR wallet, or from another chain with USDC, USDT or ETH through NEAR Intents.");
    expect(any.lead).not.toContain("pay from your NEAR wallet.");
  });
  it("in live mode the link pays from another chain only, so it never mentions the NEAR wallet", () => {
    const any = linkPayCopy(live);
    expect(any).toEqual({ lead: "Pay with USDC, USDT or ETH on Base, Ethereum, Arbitrum, Solana or Polygon.", chip: "Pay from any chain", icon: "globe" });
    const off = linkPayCopy({ ...live, offered: false, reason: "This business does not take payments from other chains yet." });
    expect(off.lead).toBe("This business does not take payments from other chains yet.");
    expect(off.lead).not.toMatch(/NEAR wallet/);
    expect(linkPayCopy({ ...live, offered: false, reason: null }).lead).toBe("Paying from another chain is not available for this link right now.");
  });
});

describe("live mode: Any chain alone has no tab bar (Q2)", () => {
  it("shows the tab bar only when the business also offers the NEAR wallet", () => {
    const only = view({ methods: ["oneclick"] });
    expect(payTabs(only, false)).toEqual(["oneclick"]);
    expect(initialTab(only, false)).toBe("oneclick");
    expect(showsTabBar(only, payTabs(only, false))).toBe(false);
    expect(showsTabBar(view(), payTabs(view(), true))).toBe(true);
    expect(showsTabBar(view({ methods: ["wallet"] }), ["wallet"])).toBe(false);
    // The wallet is offered but cannot pay this payment any more: its tab stays, disabled, so the panel keeps its shape.
    expect(showsTabBar(view(), ["oneclick"])).toBe(true);
  });
});

describe("a deposit from another chain on its way holds the NEAR wallet (A5)", () => {
  const withQuote = (q: IntentsQuote) => view({ intents: { ...view().intents!, active_quote: q } });
  it("holds it while the deposit was seen, converts or is delivered, and after a short deposit", () => {
    for (const status of ["deposit_detected", "processing", "delivered"] as const) expect(depositOnItsWay(withQuote(quote({ status })))).toBe(true);
    expect(depositOnItsWay(withQuote(quote({ status: "incomplete_deposit", deposited: { amount: "3000000", formatted: "3.000000", symbol: "USDC" } })))).toBe(true);
  });
  it("lets the buyer pay with the wallet before anything was sent, and once it ended", () => {
    expect(depositOnItsWay(view())).toBe(false);
    for (const status of ["awaiting_deposit", "confirmed", "refunded", "failed", "expired"] as const) expect(depositOnItsWay(withQuote(quote({ status })))).toBe(false);
    expect(depositOnItsWay(withQuote(quote({ status: "incomplete_deposit", deposited: null })))).toBe(false);
    expect(depositOnItsWay(view({ intents: null }))).toBe(false);
  });
  it("keeps the wallet tab, so it can say why it does not pay", () => {
    const busy = withQuote(quote({ status: "processing" }));
    expect(payTabs(busy, false)).toEqual(["wallet", "oneclick"]);
    expect(initialTab(busy, false)).toBe("oneclick");
    expect(payTabs({ ...busy, methods: ["oneclick"] }, false)).toEqual(["oneclick"]);
    expect(WALLET_HELD).toBe("A payment from another chain is on its way. Wait for it to finish.");
  });
  it("treats the node's 409 INTENTS_IN_FLIGHT the same way", () => {
    expect(isInFlightError(new ApiError(409, "INTENTS_IN_FLIGHT", "A deposit is on its way."))).toBe(true);
    expect(isInFlightError(new ApiError(409, "PAYMENT_NOT_OPEN", "x"))).toBe(false);
    expect(isInFlightError(new Error("INTENTS_IN_FLIGHT"))).toBe(false);
  });
});

describe("the deposit screen's fee lines (B1)", () => {
  it("adds the refund fee when the quote carries one", () => {
    const rows = depositFeeLines(quote().fees, "Northwind Coffee");
    expect(rows.map((r) => r.label)).toEqual(["Northwind Coffee receives", "Swap and delivery cost", "Price buffer", "Refund fee if your deposit is returned", "Arrives in"]);
    const fee = rows.find((r) => r.label === "Refund fee if your deposit is returned")!;
    expect(fee.value).toBe("0.002402 USDC");
    expect(fee.hint).toBe("Kept by NEAR Intents only if your deposit comes back.");
    expect(rows[0]!.value).toBe("4.50 USDC on NEAR");
    expect(rows[1]!.value).toBe("0.00508 USDC");
  });
  it("leaves it out when there is none", () => {
    expect(depositFeeLines({ ...quote().fees, refund_fee: null }, "Northwind Coffee").map((r) => r.label)).not.toContain("Refund fee if your deposit is returned");
  });
});

describe("the excess or unused buffer 1Click returned on a paid payment (B2)", () => {
  const paid = quote({ status: "confirmed", refunded: { amount: "4505", formatted: "0.004505", symbol: "USDC" }, refund_to: "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f" });
  it("tells the buyer what came back and where", () => {
    expect(excessReturned(paid)).toEqual({ amount: "0.004505 USDC", to: "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f", chain: "Base" });
    expect(excessReturned({ ...paid, refunded: null })).toBeNull();
    // A returned deposit is not an excess: the payment was not paid.
    expect(excessReturned({ ...paid, status: "refunded" })).toBeNull();
  });
  it("calls it an excess for the business, never a refund", () => {
    expect(returnedLabel(paid)).toBe("Excess returned to the buyer");
    expect(returnedLabel({ ...paid, status: "refunded" })).toBe("Returned to buyer");
    expect(returnedLabel(paid)).not.toMatch(/refund/i);
  });
});

describe("wrong token, wrong network or too late (B4)", () => {
  it("names the support email and the deposit address in one sentence", () => {
    expect(wrongDepositCopy(view(), quote())).toBe("Sent the wrong token, on the wrong network or too late? Contact hello@northwind.example and quote the deposit address 0x87151c5ac911a4459762ce215649313cd369dc05.");
  });
  it("falls back to the business's name", () => {
    expect(wrongDepositCopy({ merchant: { name: "Northwind Coffee", support_email: null } }, quote())).toContain("Contact Northwind Coffee and quote");
    expect(wrongDepositCopy(view(), quote())).not.toMatch(/\u2014/);
  });
});

describe("refunds of an any-chain payment are sent by hand (Q1)", () => {
  const paid = quote({ status: "confirmed", refund_to: "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f", origin_txs: [{ hash: `0x${"ab".repeat(32)}`, explorer_url: `https://basescan.org/tx/0x${"ab".repeat(32)}` }] });
  const payment = { method: "oneclick" as const, payer: "base:0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f", intents: { mode: "simulated" as const, label: "Simulated - no real money", quotes: [quote({ status: "expired", id: "iq_old" }), paid] } };
  it("reads the buyer's refund address, chain, token and deposit from the quote that paid", () => {
    expect(manualRefundOf(payment, 4500000n)).toEqual({ chain: "base", chain_name: "Base", symbol: "USDC", refund_to: "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f", deposit_tx: paid.origin_txs[0], refundable: "4500000" });
  });
  it("falls back to the payer when the quotes are missing, and is null for a NEAR payment", () => {
    expect(manualRefundOf({ ...payment, payer: "sol:So11111111111111111111111111111111111111112", intents: null }, 1n)).toEqual({ chain: "sol", chain_name: "Solana", symbol: null, refund_to: "So11111111111111111111111111111111111111112", deposit_tx: null, refundable: "1" });
    expect(manualRefundOf({ method: "wallet", payer: "alice.testnet", intents: null }, 1n)).toBeNull();
    expect(manualRefundOf({ method: "oneclick", payer: null, intents: null }, 1n)).toBeNull();
  });
  it("reads the details of 409 REFUND_MANUAL_REQUIRED, and nothing else", () => {
    const details = { chain: "base", chain_name: "Base", symbol: "USDC", refund_to: "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f", deposit_tx: null, refundable: "4500000" };
    expect(manualRefundFromError(new ApiError(409, "REFUND_MANUAL_REQUIRED", "Send it by hand.", details))).toEqual(details);
    expect(manualRefundFromError(new ApiError(409, "REFUND_MANUAL_REQUIRED", "Send it by hand.", { chain: "base" }))).toBeNull();
    expect(manualRefundFromError(new ApiError(422, "REFUND_TOO_LARGE", "x", details))).toBeNull();
    expect(manualRefundFromError(new Error("x"))).toBeNull();
  });
  it("checks the transaction hash's format on the buyer's chain", () => {
    expect(originTxProblem("base", "Base", `0x${"ab".repeat(32)}`)).toBeNull();
    expect(originTxProblem("base", "Base", ` 0x${"AB".repeat(32)} `)).toBeNull();
    expect(originTxProblem("base", "Base", "")).toBe("Enter the transaction hash on Base.");
    expect(originTxProblem("eth", "Ethereum", "0x123")).toBe("That is not an Ethereum transaction hash. It is 0x followed by 64 characters, 0 to 9 and a to f.");
    expect(originTxProblem("sol", "Solana", "5".repeat(88))).toBeNull();
    expect(originTxProblem("sol", "Solana", `0x${"ab".repeat(32)}`)).toBe("That is not a Solana transaction signature. It is 64 to 90 letters and digits, like the one your wallet shows.");
    expect(originTxProblem("xyz", "Xyz", "a".repeat(64))).toBeNull();
    expect(originTxProblem("xyz", "Xyz", "not a hash!")).toBe("That does not look like a transaction hash on Xyz.");
  });
});
