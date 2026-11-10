import { describe, expect, it } from "vitest";
import { KEEP_ALERTS, operatorAlertOf, operatorAlerts, retainEvents } from "@/lib/operator-alerts";
import type { NodeEvent } from "@/lib/schemas";

const H = "ab".repeat(32);
const event = (alert: unknown, id = "ev_1"): NodeEvent => ({ type: "operator.alert", id, at: "2026-11-10T08:00:00.000Z", data: { alert } as Record<string, unknown> });
const fact = (a: NonNullable<ReturnType<typeof operatorAlertOf>>, label: string) => a.facts.find((f) => f.label === label);

describe("operatorAlertOf", () => {
  it("says what happened and what to do when a seller settled a voucher the server never accepted", () => {
    const a = operatorAlertOf(event({ kind: "seller_settled_uncleared", message: "a payee settled a voucher on the hub that this node never accepted", sellerSettlement: "sst_0123456789abcdef", budgetId: H, payee: "risk-scan.testnet", uncleared: "40000", hubSettled: "1240000" }))!;
    expect(a.title).toBe("A seller settled a voucher this server never accepted");
    expect(a.happened).toContain("booked as uncleared");
    expect(a.todo).toContain("receipt key");
    expect(fact(a, "Payee")).toEqual({ label: "Payee", value: "risk-scan.testnet", as: "account" });
    expect(fact(a, "Never cleared here")).toEqual({ label: "Never cleared here", value: "40000", as: "amount" });
    expect(fact(a, "Settled on the hub")!.as).toBe("amount");
    expect(fact(a, "Seller settlement")!.value).toBe("sst_0123456789abcdef");
    expect(a).toMatchObject({ id: "ev_1", at: "2026-11-10T08:00:00.000Z", kind: "seller_settled_uncleared" });
  });
  it("carries the server's reason for a batch the hub holds under another settler or root", () => {
    const a = operatorAlertOf(event({ kind: "batch_mismatch", message: "the hub's batch under this id was settled by other.testnet, not by this node (node.payminto.testnet)", batchId: H, seq: 4, hubSettler: "other.testnet", hubRoot: H, nodeRoot: "cd".repeat(32) }))!;
    expect(a.title).toBe("The hub holds a batch this server did not settle");
    expect(a.happened).toMatch(/^The hub's batch under this id was settled by other\.testnet, not by this node \(node\.payminto\.testnet\)\. The server did not book settlement batch #4/);
    expect(a.todo).toContain("Compare the hub's record");
    expect(fact(a, "Settler on the hub")).toEqual({ label: "Settler on the hub", value: "other.testnet", as: "account" });
    expect(fact(a, "Root on this server")!.value).toBe("cd".repeat(32));
  });
  it("tells the operator the database and the hub do not belong together when the hub is behind", () => {
    const a = operatorAlertOf(event({ kind: "settled_position_behind", message: "the hub's settled position is behind this node's", budgetId: H, payee: "market-data.testnet", hubSettled: "1000", nodeSettled: "5000" }))!;
    expect(a.title).toBe("The hub's settled position is behind this server's");
    expect(a.happened).toContain("do not belong together");
    expect(a.todo).toContain("HUB_ACCOUNT, NETWORK and DB_PATH");
    expect(fact(a, "Settled on this server")).toEqual({ label: "Settled on this server", value: "5000", as: "amount" });
  });
  it("still shows an alert of a kind it does not know, with the server's own message", () => {
    const a = operatorAlertOf(event({ kind: "something_new", message: "the widget fell off" }))!;
    expect(a.kind).toBe("something_new");
    expect(a.happened).toBe("The widget fell off.");
    expect(a.todo).toContain("error log");
    expect(a.facts).toEqual([]);
  });
  it("leaves out a fact the server did not send and an amount that is not one", () => {
    const a = operatorAlertOf(event({ kind: "seller_settled_uncleared", message: "m", payee: "risk-scan.testnet", uncleared: "not a number", hubSettled: null }))!;
    expect(a.facts.map((f) => f.label)).toEqual(["Payee"]);
  });
  it("ignores other events and an alert event with nothing in it", () => {
    expect(operatorAlertOf({ type: "call.accepted", id: "1", at: "t", data: { alert: { kind: "batch_mismatch" } } })).toBeNull();
    expect(operatorAlertOf(event(undefined))).toBeNull();
    expect(operatorAlertOf(event("oops"))).toBeNull();
  });
  it("never uses an em dash", () => {
    for (const kind of ["batch_mismatch", "seller_settled_uncleared", "settled_position_behind", "other"]) {
      const a = operatorAlertOf(event({ kind, message: "m" }))!;
      expect(`${a.title} ${a.happened} ${a.todo}`).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
    }
  });
});

describe("the live event list", () => {
  const call = (i: number): NodeEvent => ({ type: "call.accepted", id: `c${i}`, at: "t", data: {} });
  it("keeps an operator alert however much traffic follows it", () => {
    const events = [...Array.from({ length: 200 }, (_, i) => call(i)), event({ kind: "batch_mismatch", message: "m" }, "alert")];
    const kept = retainEvents(events, 60);
    expect(kept).toHaveLength(61);
    expect(kept.at(-1)!.id).toBe("alert");
    expect(kept.slice(0, 60).map((e) => e.id)).toEqual(events.slice(0, 60).map((e) => e.id));
  });
  it("bounds the alerts it keeps to the newest", () => {
    const alerts = Array.from({ length: KEEP_ALERTS + 5 }, (_, i) => event({ kind: "batch_mismatch", message: "m" }, `a${i}`));
    const kept = retainEvents(alerts, 60);
    expect(kept).toHaveLength(KEEP_ALERTS);
    expect(kept[0]!.id).toBe("a0");
  });
  it("lists alerts newest first without the dismissed ones", () => {
    const events = [event({ kind: "batch_mismatch", message: "m" }, "a2"), call(1), event({ kind: "settled_position_behind", message: "m" }, "a1")];
    expect(operatorAlerts(events).map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(operatorAlerts(events, new Set(["a2"])).map((a) => a.id)).toEqual(["a1"]);
  });
});
