import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunTimeline } from "@/components/agents/run-timeline";
import type { AgentRunEvent } from "@/lib/schemas";

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): AgentRunEvent => ({ seq, type, data, at: new Date(Date.UTC(2026, 10, 1, 10, 0, seq)).toISOString() });

describe("RunTimeline", () => {
  it("shows model turns with token counts, tool calls with input and result, and that it is still working", () => {
    render(
      <RunTimeline
        status="running"
        events={[
          ev(1, "started", { attempt: 1 }),
          ev(2, "model_turn", { input_tokens: 1840, output_tokens: 96, stop: "tool_use", model: "claude-sonnet-5-5" }),
          ev(3, "tool_call", { id: "tc_1", name: "get_overview", input: { range: "7d" } }),
          ev(4, "tool_result", { id: "tc_1", name: "get_overview", summary: "This week 2,948.75 USDC from 131 payments." }),
          ev(5, "tool_call", { id: "tc_2", name: "list_payments", input: { limit: 20 } }),
        ]}
      />,
    );
    expect(screen.getByText("1,840 in, 96 out")).toBeInTheDocument();
    expect(screen.getByText("Read the overview")).toBeInTheDocument();
    expect(screen.getByText("range: 7d")).toBeInTheDocument();
    expect(screen.getByText("This week 2,948.75 USDC from 131 payments.")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the result...")).toBeInTheDocument();
    expect(screen.getByText("Working...")).toBeInTheDocument();
  });
  it("ends on the final status with no working row", () => {
    render(<RunTimeline status="timed_out" events={[ev(1, "started"), ev(2, "finished", { status: "timed_out" })]} />);
    expect(screen.getByText("Timed out")).toBeInTheDocument();
    expect(screen.queryByText("Working...")).toBeNull();
  });
});
