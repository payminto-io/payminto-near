import { describe, expect, it } from "vitest";
import { contrastRatio, embedButtonHtml, linkExpiry, toLocalInput } from "@/lib/gateway";

describe("linkExpiry", () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  it("maps the presets to an ISO time or null", () => {
    expect(linkExpiry("never", "", now)).toEqual({ ok: true, iso: null });
    expect(linkExpiry("24h", "", now)).toEqual({ ok: true, iso: new Date(now + 86_400_000).toISOString() });
    expect(linkExpiry("7d", "", now)).toEqual({ ok: true, iso: new Date(now + 7 * 86_400_000).toISOString() });
  });
  it("needs a custom time at least a minute ahead", () => {
    expect(linkExpiry("custom", "", now).ok).toBe(false);
    expect(linkExpiry("custom", new Date(now + 30_000).toISOString(), now).ok).toBe(false);
    const later = new Date(now + 3_600_000).toISOString();
    expect(linkExpiry("custom", later, now)).toEqual({ ok: true, iso: later });
  });
  it("round-trips through a datetime-local value", () => {
    const iso = new Date(2026, 10, 2, 9, 30).toISOString();
    expect(new Date(toLocalInput(iso)).toISOString()).toBe(iso);
    expect(toLocalInput(null)).toBe("");
  });
});

describe("embedButtonHtml", () => {
  it("uses the brand colour with a readable text colour", () => {
    const light = embedButtonHtml("https://pay.example/l/abc", "#fde68a");
    expect(light.background).toBe("#fde68a");
    expect(light.color).toBe("#0e1726");
    const dark = embedButtonHtml("https://pay.example/l/abc", "#0f766e");
    expect(dark.color).toBe("#ffffff");
    expect(contrastRatio(dark.background, dark.color)).toBeGreaterThanOrEqual(4.5);
    expect(dark.html).toContain("background:#0f766e;color:#ffffff");
  });
  it("falls back to the default colour and escapes the URL", () => {
    const b = embedButtonHtml('https://pay.example/l/a"b', null);
    expect(b.background).toBe("#0e1726");
    expect(b.html).toContain("a&quot;b");
  });
});
