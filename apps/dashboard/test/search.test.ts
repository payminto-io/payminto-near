import { describe, expect, it } from "vitest";
import { buildGroups, cycleFilter, detect, flatten, highlight, moveIndex, parseQuery, pushRecent, searchResponseSchema, shouldSearchServer, typesFor, type SearchItem } from "@/lib/search";

const page = (title: string, href: string, keywords?: string[]): SearchItem => ({ key: `page:${href}`, type: "page", id: href, title, href, keywords });
const action = (title: string, id: string): SearchItem => ({ key: `action:${id}`, type: "action", id, title, action: id });
const pages = [page("Payments", "/payments"), page("Payment links", "/links"), page("Budgets", "/mandates", ["mandate"]), page("HashKey Chain", "/developers/hashkey", ["rpc"])];
const actions = [action("New payment link", "newLink"), action("Switch business", "switch")];

describe("parseQuery and detect (PRODUCT.md 5.2)", () => {
  it("reads typed prefixes as one group", () => {
    expect(parseQuery("p: 1001")).toEqual({ filter: "payment", text: "1001" });
    expect(parseQuery("> new")).toEqual({ filter: "action", text: "new" });
    expect(parseQuery("a:agent")).toEqual({ filter: "budget", text: "agent" });
    expect(parseQuery("plain")).toEqual({ filter: null, text: "plain" });
  });
  it("detects ids, hashes, addresses, emails and amounts", () => {
    expect(detect("pay_01H")).toEqual({ kind: "id", type: "payment" });
    expect(detect("plink_x")).toEqual({ kind: "id", type: "link" });
    expect(detect(`0x${"a".repeat(64)}`)).toEqual({ kind: "tx_hash" });
    expect(detect(`0x${"b".repeat(40)}`)).toEqual({ kind: "address" });
    expect(detect("alice@example.com")).toEqual({ kind: "email" });
    expect(detect("12.5")).toEqual({ kind: "amount" });
    expect(detect("x")).toEqual({ kind: "short" });
    expect(detect("coffee")).toEqual({ kind: "text" });
  });
  it("searches the server only from 2 characters and never for actions", () => {
    expect(shouldSearchServer("a")).toBe(false);
    expect(shouldSearchServer("ab")).toBe(true);
    expect(shouldSearchServer("> new link")).toBe(false);
    expect(typesFor("budget")).toEqual(["budget", "paid_service", "settlement"]);
    expect(typesFor(null)).toBeNull();
  });
});

describe("buildGroups", () => {
  const remote = searchResponseSchema.parse({
    groups: [
      { type: "link", total: 1, items: [{ id: "plink_1", title: "Pro plan", href: "/links/plink_1" }] },
      { type: "payment", total: 12, items: [{ id: "pay_1", title: "Order 1001", subtitle: "Paid", href: "/payments/pay_1", matched: { field: "tx_hash", snippet: "0x9f" } }] },
      { type: "unknown_type", items: [{ id: "z", title: "dropped" }] },
    ],
  }).groups;

  it("shows Recent, Actions and Pages for an empty query", () => {
    const g = buildGroups({ query: "", recent: [{ key: "r", type: "recent", id: "/x", title: "X", href: "/x" }], actions, pages, remote: [] });
    expect(g.map((x) => x.type)).toEqual(["recent", "action", "page"]);
  });
  it("orders groups as section 5.2 and drops unknown types", () => {
    const g = buildGroups({ query: "pay", recent: [], actions, pages, remote });
    expect(g.map((x) => x.type)).toEqual(["action", "page", "payment", "link"]);
    expect(g.find((x) => x.type === "payment")!.total).toBe(12);
  });
  it("matches pages by title first, then keywords", () => {
    const g = buildGroups({ query: "mandate", recent: [], actions, pages, remote: [] });
    expect(flatten(g).map((i) => i.title)).toEqual(["Budgets"]);
  });
  it("keeps only the filtered group", () => {
    const g = buildGroups({ query: "l: pro", recent: [], actions, pages, remote });
    expect(g.map((x) => x.type)).toEqual(["link"]);
    expect(buildGroups({ query: ">", recent: [], actions, pages, remote }).map((x) => x.type)).toEqual(["action"]);
  });
});

describe("keyboard model", () => {
  it("wraps arrows around the list", () => {
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
  it("cycles the filter chip with Tab and back to none", () => {
    const f = ["payment", "link"] as const;
    expect(cycleFilter(null, [...f])).toBe("payment");
    expect(cycleFilter("link", [...f])).toBeNull();
    expect(cycleFilter(null, [...f], true)).toBe("link");
  });
  it("highlights the matched part", () => {
    expect(highlight("Payment links", "link")).toEqual([
      { text: "Payment ", match: false },
      { text: "link", match: true },
      { text: "s", match: false },
    ]);
    expect(highlight("abc", "zz")).toEqual([{ text: "abc", match: false }]);
  });
  it("keeps recent items unique and newest first", () => {
    const a = page("A", "/a");
    const b = page("B", "/b");
    const list = pushRecent(pushRecent(pushRecent([], a), b), a);
    expect(list.map((i) => i.href)).toEqual(["/a", "/b"]);
    expect(list.every((i) => i.type === "recent")).toBe(true);
  });
});
