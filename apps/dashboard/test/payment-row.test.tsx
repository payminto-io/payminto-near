import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaymentRow } from "@/components/gateway/payment-row";

vi.mock("@/lib/queries", () => ({ useExplorer: () => ({ tx: (h: string) => h, address: (a: string) => a }), useToken: () => ({ symbol: "USDC", decimals: 6 }) }));

const payment = {
  id: "pay_aaaaaaaaaaaaaaaaaaaaaaaa",
  merchant_id: "mer_aaaaaaaaaaaaaaaaaaaaaaaa",
  amount_due: "4500000",
  status: "paid",
  late: false,
  description: "Bag of beans, 250 g",
  link_id: "lnk_1",
  reference: null,
  refund_status: "none",
  payer: "base:0x5f2b3a1e9c7d4b6a8f0e1d2c3b4a59687766554f",
  created_at: "2026-11-13T12:00:00.000Z",
} as never;

describe("a payment row in a narrow card", () => {
  it("compact: no window-width columns, so the description is never squeezed to a letter", () => {
    render(
      <ul>
        <PaymentRow p={payment} compact />
      </ul>,
    );
    const row = screen.getByRole("listitem");
    // The full-width list's column template switches on the window's width; a narrow card must not use it.
    expect(row.className).not.toMatch(/md:grid-cols-/);
    expect(row.textContent).toContain("Bag of beans, 250 g");
  });

  it("the full-width list keeps its columns", () => {
    render(
      <ul>
        <PaymentRow p={payment} />
      </ul>,
    );
    expect(screen.getByRole("listitem").className).toMatch(/md:grid-cols-/);
  });
});
