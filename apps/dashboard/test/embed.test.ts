import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureOpenerOrigin, embedSnippet, notifyOpener, parseOpenerOrigin, paymentMessage, withoutOpenerParam } from "@/lib/embed";

describe("the opener's origin in the fragment", () => {
  it("takes an http or https origin and nothing else", () => {
    expect(parseOpenerOrigin("#payminto-origin=https%3A%2F%2Fshop.example")).toBe("https://shop.example");
    expect(parseOpenerOrigin("#payminto-origin=http%3A%2F%2Flocalhost%3A8080")).toBe("http://localhost:8080");
    expect(parseOpenerOrigin("#payminto-origin=https%3A%2F%2Fshop.example%2Fpath")).toBeNull();
    expect(parseOpenerOrigin("#payminto-origin=javascript%3Aalert(1)")).toBeNull();
    expect(parseOpenerOrigin("#payminto-origin=*")).toBeNull();
    expect(parseOpenerOrigin("")).toBeNull();
  });
  it("leaves the rest of the fragment alone", () => {
    expect(withoutOpenerParam("#payminto-origin=https%3A%2F%2Fshop.example")).toBe("");
    expect(withoutOpenerParam("#a=1&payminto-origin=x")).toBe("#a=1");
  });
});

describe("telling the opener", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    Object.defineProperty(window, "opener", { value: null, configurable: true, writable: true });
  });

  it("posts the payment's state to the origin the fragment named, and only to it", () => {
    window.history.replaceState(null, "", "/l/coffee#payminto-origin=https%3A%2F%2Fshop.example");
    captureOpenerOrigin();
    expect(window.location.hash).toBe("");
    const postMessage = vi.fn();
    Object.defineProperty(window, "opener", { value: { postMessage }, configurable: true, writable: true });
    notifyOpener({ id: "pay_1", status: "paid" });
    expect(postMessage).toHaveBeenCalledWith({ type: "payminto:payment", id: "pay_1", status: "paid" }, "https://shop.example");
  });

  it("says nothing without an opener or without a named origin", () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "opener", { value: { postMessage }, configurable: true, writable: true });
    notifyOpener({ id: "pay_1", status: "paid" });
    expect(postMessage).not.toHaveBeenCalled();
    expect(paymentMessage({ id: "pay_2", status: "open" })).toEqual({ type: "payminto:payment", id: "pay_2", status: "open" });
  });
});

describe("the two lines a business pastes", () => {
  it("fills in the dashboard's origin and the slug", () => {
    const s = embedSnippet("https://pay.example.com/l/coffee-5usd", "coffee-5usd");
    expect(s.script).toBe('<script src="https://pay.example.com/embed.js" defer></script>');
    expect(s.button).toBe('<button type="button" data-payminto-link="coffee-5usd">Pay with crypto</button>');
    expect(s.all.split("\n")).toHaveLength(2);
    expect(embedSnippet("https://pay.example.com/l/x", 'x"><img>').button).toContain('data-payminto-link="ximg"');
  });
});

describe("public/embed.js", () => {
  const src = readFileSync(join(process.cwd(), "public/embed.js"), "utf8");

  it("is small, has no dependency and no em dash", () => {
    expect(src.length).toBeLessThan(6_000);
    expect(src).not.toMatch(/\bimport\b|\brequire\(/);
    expect(src).not.toMatch(/\u2014/);
  });

  it("opens the checkout for a button and tells the page when it is paid", async () => {
    document.body.innerHTML = '<button id="b" data-payminto-link="coffee-5usd">Pay</button>';
    const popup = { focus: vi.fn(), closed: false };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    // As a page loads it: a script tag whose address names the checkout's origin (jsdom does not fetch it).
    const tag = document.createElement("script");
    tag.src = "https://pay.example.com/embed.js";
    document.head.appendChild(tag);
    new Function(src)();
    const button = document.getElementById("b")!;
    button.click();
    expect(open).toHaveBeenCalledTimes(1);
    const url = String(open.mock.calls[0]![0]);
    expect(url).toBe(`https://pay.example.com/l/coffee-5usd#payminto-origin=${encodeURIComponent(window.location.origin)}`);
    const paid = vi.fn();
    const any = vi.fn();
    button.addEventListener("payminto:paid", paid);
    button.addEventListener("payminto:payment", any);
    window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: { type: "payminto:payment", id: "pay_1", status: "paid" }, source: popup as unknown as Window }));
    expect(paid).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { origin: "https://pay.example.com", data: { type: "payminto:payment", id: "pay_1", status: "processing" }, source: popup as unknown as Window }));
    window.dispatchEvent(new MessageEvent("message", { origin: "https://pay.example.com", data: { type: "payminto:payment", id: "pay_1", status: "paid" }, source: popup as unknown as Window }));
    expect(any).toHaveBeenCalledTimes(2);
    expect(paid).toHaveBeenCalledTimes(1);
    expect((paid.mock.calls[0]![0] as CustomEvent).detail).toEqual({ id: "pay_1", status: "paid" });
  });

  it("navigates in the same tab when the popup is blocked", () => {
    document.body.innerHTML = '<a id="a" href="#" data-payminto-payment="pay_abc">Pay</a>';
    vi.spyOn(window, "open").mockReturnValue(null);
    const assign = vi.fn();
    const g = window as unknown as { __paymintoEmbed?: { go: (u: string) => void } };
    g.__paymintoEmbed!.go = assign;
    document.getElementById("a")!.click();
    expect(assign).toHaveBeenCalledWith("https://pay.example.com/pay/pay_abc");
  });
});
