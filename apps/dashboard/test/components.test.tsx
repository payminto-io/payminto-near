import { describe, expect, it, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { getAddress } from "viem";
import { FlowGraph, wrapLabel } from "@/components/app/flow-graph";
import { StatStrip } from "@/components/app/stat-strip";

beforeAll(() => {
  class RO {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe() {
      this.cb([{ contentRect: { width: 640 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
});

const A = getAddress("0x00000000000000000000000000000000000000a1");
const MD = getAddress("0x00000000000000000000000000000000000000d1");
const names: Record<string, string> = { [A]: "Treasury Agent", [MD]: "Market Data" };

describe("FlowGraph", () => {
  it("renders one labelled, focusable ribbon per obligation with money and units", () => {
    render(
      <FlowGraph
        obligations={[{ from: A, to: MD, amount: "184000", calls: 92 }]}
        nameOf={(a) => names[a] ?? null}
        symbol="USDC"
        decimals={6}
      />,
    );
    const ribbon = screen.getByRole("img", { name: "Treasury Agent to Market Data: 0.184 USDC, 92 calls" });
    expect(ribbon).toHaveAttribute("tabindex", "0");
    expect(screen.getAllByText("0.184 USDC")).toHaveLength(2);
  });
});

describe("wrapLabel", () => {
  it("wraps on words before truncating", () => {
    expect(wrapLabel("Market Data", 20)).toEqual(["Market Data"]);
    expect(wrapLabel("Treasury Agent", 10)).toEqual(["Treasury", "Agent"]);
    expect(wrapLabel("Extraordinarily Long Provider Name", 10)).toEqual(["Extraordi…", "Long Prov…"]);
  });
});

describe("StatStrip", () => {
  it("renders each figure with its label and note", () => {
    render(<StatStrip stats={[{ label: "Compression", value: "34.5", note: "calls per on-chain transfer" }]} />);
    expect(screen.getByText("Compression")).toBeInTheDocument();
    expect(screen.getByText("34.5")).toBeInTheDocument();
    expect(screen.getByText("calls per on-chain transfer")).toBeInTheDocument();
  });
});
