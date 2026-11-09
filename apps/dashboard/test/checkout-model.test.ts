import { describe, expect, it } from "vitest";
import {
  amountPresets,
  availableMethods,
  brandVars,
  checkoutModel,
  confirmStage,
  countdownFraction,
  countdownModel,
  initialMethod,
  paidFraction,
  panelKind,
  quoteFor,
  redirectFraction,
  rememberQuote,
  walletStepCopy,
  walletStepIndex,
  type CheckoutPhase,
} from "@/lib/checkout";
import type { CheckoutView } from "@/lib/schemas";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ADDR = "0x00000000000000000000000000000000000000a1";

function view(over: Partial<CheckoutView> = {}): CheckoutView {
  return {
    id: "pay_test",
    livemode: false,
    status: "open",
    late: false,
    merchant: { name: "Acme Store", brand_color: "#0f766e" },
    description: "Pro plan",
    reference: null,
    amount: "25000000",
    surcharge: "0",
    amount_due: "25000000",
    amount_paid: "0",
    amount_remaining: "25000000",
    chain_id: 133,
    token: { address: ADDR, symbol: "USDC", decimals: 6 } as CheckoutView["token"],
    deposit_address: ADDR,
    method: "wallet",
    methods: ["wallet", "deposit"],
    authorization: null,
    success_url: null,
    order_hash: `0x${"ab".repeat(32)}`,
    expires_at: iso(NOW + 20 * 60_000),
    created_at: iso(NOW - 10 * 60_000),
    ...over,
  } as CheckoutView;
}

describe("quoteFor: the amount due for each way of paying", () => {
  it("uses the node's numbers for the method it quoted", () => {
    const q = quoteFor(view({ method: "deposit", surcharge: "100000", amount_due: "25100000", amount_remaining: "25100000" }), "deposit");
    expect(q).toEqual({ surcharge: 100000n, due: 25100000n, remaining: 25100000n, known: true, ready: true });
  });
  it("marks the other method as not known until it is re-quoted, starting from the business's price", () => {
    const q = quoteFor(view({ method: "deposit", surcharge: "100000", amount_due: "25100000" }), "wallet");
    expect(q).toEqual({ surcharge: 0n, due: 25000000n, remaining: 25000000n, known: false, ready: false });
  });
  it("shows a quote seen earlier at once, but is not ready to pay until the node re-quotes", () => {
    let cache = rememberQuote({}, view({ method: "deposit", surcharge: "100000", amount_due: "25100000" }));
    cache = rememberQuote(cache, view({ method: "wallet" }));
    const q = quoteFor(view({ method: "wallet" }), "deposit", cache);
    expect(q.due).toBe(25100000n);
    expect(q.surcharge).toBe(100000n);
    expect(q.known).toBe(true);
    expect(q.ready).toBe(false);
  });
  it("binds the remainder once money arrived, whatever method is picked", () => {
    const v = view({ status: "partially_paid", method: "deposit", amount_paid: "20000000", amount_remaining: "5000000" });
    expect(quoteFor(v, "wallet").remaining).toBe(5000000n);
    expect(quoteFor(v, "wallet").ready).toBe(true);
    expect(rememberQuote({}, v)).toEqual({});
  });
});

describe("methods", () => {
  it("offers the wallet only while it can still be quoted for it", () => {
    expect(availableMethods(view())).toEqual(["wallet", "deposit"]);
    expect(availableMethods(view({ status: "partially_paid", amount_paid: "1" }))).toEqual(["deposit"]);
    expect(availableMethods(view({ methods: ["deposit"] }))).toEqual(["deposit"]);
  });
  it("opens on Send to address when there is no browser wallet", () => {
    expect(initialMethod(view(), false)).toBe("deposit");
    expect(initialMethod(view(), true)).toBe("wallet");
    expect(initialMethod(view({ method: "deposit" }), true)).toBe("deposit");
    expect(initialMethod(view({ methods: [] }), true)).toBeNull();
  });
});

describe("checkoutModel: state to what the panel shows", () => {
  const cases: [Partial<CheckoutView>, { signing?: boolean }, CheckoutPhase, string, string][] = [
    [{}, {}, "open", "pay", "Waiting for payment"],
    [{}, { signing: true }, "signing", "signing", "Waiting for your wallet"],
    [{ status: "partially_paid", amount_paid: "20000000", amount_remaining: "5000000" }, {}, "partially_paid", "pay", "Partly paid"],
    [{ status: "processing" }, {}, "processing", "confirming", "Confirming"],
    [{ status: "paid", amount_paid: "25000000" }, {}, "paid", "success", "Paid"],
    [{ status: "overpaid", amount_paid: "25500000" }, {}, "overpaid", "success", "Paid extra"],
    [{ status: "underpaid", amount_paid: "20000000" }, {}, "underpaid", "ended", "Incomplete"],
    [{ status: "expired" }, {}, "expired", "ended", "Expired"],
    [{ status: "canceled" }, {}, "canceled", "ended", "Canceled"],
    [{ expires_at: iso(NOW - 1000) }, {}, "expired", "ended", "Expired"],
  ];
  it.each(cases)("%j %j reads as %s", (over, opts, phase, panel, chip) => {
    const m = checkoutModel(view(over), { now: NOW, ...opts });
    expect(m.phase).toBe(phase);
    expect(m.panel).toBe(panel);
    expect(m.chip.label).toBe(chip);
    expect(m.announce).toContain(m.copy.headline);
    expect(`${m.copy.headline}${m.copy.body}${m.copy.next}`).not.toMatch(/\u2014/);
  });
  it("carries a countdown only while money can still be sent", () => {
    expect(checkoutModel(view(), { now: NOW }).countdown?.text).toBe("20:00");
    expect(checkoutModel(view({ status: "paid" }), { now: NOW }).countdown).toBeNull();
  });
  it("names the business in what to do next", () => {
    expect(checkoutModel(view({ status: "overpaid", amount_paid: "25500000" }), { now: NOW }).copy.next).toBe("You sent 0.50 USDC more than asked. Acme Store can refund the extra.");
    expect(checkoutModel(view({ status: "expired" }), { now: NOW }).copy.next).toContain("Ask Acme Store for a new payment link");
  });
  it("maps every phase to one panel", () => {
    expect(panelKind("partially_paid")).toBe("pay");
    expect(panelKind("underpaid")).toBe("ended");
  });
});

describe("progress", () => {
  it("fills the partly paid bar by the share received", () => {
    expect(paidFraction({ amount_due: "25000000", amount_paid: "20000000" })).toBe(0.8);
    expect(paidFraction({ amount_due: "25000000", amount_paid: "30000000" })).toBe(1);
    expect(paidFraction({ amount_due: "0", amount_paid: "0" })).toBe(0);
  });
  it("walks the ring through Seen, Sent and Final, closing it only when paid", () => {
    expect(confirmStage({ status: "open", confirmations: null })).toEqual({ step: 0, fraction: 0 });
    expect(confirmStage({ status: "processing", confirmations: null })).toEqual({ step: 1, fraction: 1 / 3 });
    const sent = confirmStage({ status: "processing", confirmations: { current: 1, required: 2 } });
    expect(sent.step).toBe(2);
    expect(sent.fraction).toBeCloseTo(2 / 3);
    expect(confirmStage({ status: "processing", confirmations: { current: 5, required: 2 } }).fraction).toBeLessThan(1);
    expect(confirmStage({ status: "paid", confirmations: null })).toEqual({ step: 3, fraction: 1 });
  });
});

describe("countdown and redirect", () => {
  it("shrinks the time bar from 1 to 0 over the payment window", () => {
    const created = iso(NOW - 10 * 60_000);
    const expires = iso(NOW + 10 * 60_000);
    expect(countdownFraction(created, expires, NOW)).toBe(0.5);
    expect(countdownFraction(created, expires, NOW + 3_600_000)).toBe(0);
    expect(countdownFraction(expires, created, NOW)).toBe(0);
  });
  it("turns amber under five minutes and red under one", () => {
    const m = (s: number) => countdownModel({ created_at: iso(NOW - 60_000), expires_at: iso(NOW + s * 1000) }, NOW);
    expect(m(400).tone).toBe("neutral");
    expect(m(240).tone).toBe("warning");
    expect(m(30)).toMatchObject({ tone: "danger", text: "0:30", label: "30 seconds left" });
  });
  it("fills the return ring over five seconds", () => {
    expect(redirectFraction(NOW, NOW)).toBe(0);
    expect(redirectFraction(NOW, NOW + 2500)).toBe(0.5);
    expect(redirectFraction(NOW, NOW + 9000)).toBe(1);
  });
});

describe("wallet steps", () => {
  it("guides through connect, switch network and approve in plain words", () => {
    expect(walletStepCopy("switching", "HashKey Chain Testnet").title).toBe("Switching to HashKey Chain Testnet");
    expect(walletStepIndex("idle")).toBe(-1);
    expect(walletStepIndex("connecting")).toBe(0);
    expect(walletStepIndex("approving")).toBe(2);
    expect(walletStepIndex("submitting")).toBe(3);
  });
});

describe("brandVars", () => {
  it("keeps a dark brand for rings in light mode and falls back where it would vanish", () => {
    const v = brandVars("#0f766e");
    expect(v["--brand"]).toBe("#0f766e");
    expect(v["--brand-fg"]).toBe("#ffffff");
    expect(v["--brand-ink"]).toBe("#0f766e");
    expect(v["--brand-ink-dark"]).toBe("#0f766e");
    const navy = brandVars("#1e2a5a");
    expect(navy["--brand-ink"]).toBe("#1e2a5a");
    expect(navy["--brand-ink-dark"]).toBe("var(--primary)");
  });
  it("uses dark text on a light brand and never draws pale yellow on white", () => {
    const v = brandVars("#fde047");
    expect(v["--brand-fg"]).toBe("#0e1726");
    expect(v["--brand-ink"]).toBe("var(--primary)");
    expect(v["--brand-ink-dark"]).toBe("#fde047");
  });
  it("ignores anything that is not a hex colour", () => {
    expect(brandVars("red; background:url(x)")).toEqual({});
    expect(brandVars(null)).toEqual({});
  });
});

describe("amountPresets", () => {
  const U = 1_000_000n;
  it("offers round amounts inside the link's range", () => {
    expect(amountPresets(null, null)).toEqual([5n * U, 10n * U, 25n * U, 50n * U]);
    expect(amountPresets(20n * U, 120n * U)).toEqual([20n * U, 25n * U, 50n * U, 100n * U]);
    expect(amountPresets(10n * U, 30n * U)).toEqual([10n * U, 25n * U]);
  });
  it("offers nothing when no round amount fits", () => {
    expect(amountPresets(1_100_000n, 1_200_000n)).toEqual([1_100_000n]);
    expect(amountPresets(null, 1n * U)).toEqual([]);
  });
});
