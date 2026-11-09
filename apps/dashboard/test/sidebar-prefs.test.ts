import { describe, expect, it } from "vitest";
import { clearPrefs, isSectionOpen, loadPrefs, parsePrefs, prefsKey, savePrefs, toggleSection } from "@/lib/sidebar-prefs";

const records = { id: "records" as const, defaultOpen: false };
const payments = { id: "payments" as const, defaultOpen: true };

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("sidebar prefs", () => {
  it("parses only what it expects", () => {
    expect(parsePrefs(null)).toEqual({ sections: {}, rail: null });
    expect(parsePrefs("not json")).toEqual({ sections: {}, rail: null });
    expect(parsePrefs(JSON.stringify({ sections: { records: true, bogus: true, payments: "x" }, rail: true }))).toEqual({ sections: { records: true }, rail: true });
  });
  it("round-trips per user", () => {
    const s = memory();
    savePrefs("usr_1", { sections: { records: true }, rail: false }, s);
    expect(loadPrefs("usr_1", s)).toEqual({ sections: { records: true }, rail: false });
    expect(loadPrefs("usr_2", s)).toEqual({ sections: {}, rail: null });
    expect(prefsKey(null)).toBe("payminto.sidebar.anon");
    clearPrefs("usr_1", s);
    expect(loadPrefs("usr_1", s)).toEqual({ sections: {}, rail: null });
  });
  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadPrefs("u", broken)).toEqual({ sections: {}, rail: null });
    expect(() => savePrefs("u", { sections: {}, rail: true }, broken)).not.toThrow();
    expect(() => clearPrefs("u", broken)).not.toThrow();
  });
  it("opens the section holding the page, then the user's choice, then the default", () => {
    expect(isSectionOpen(records, { sections: {}, rail: null }, null)).toBe(false);
    expect(isSectionOpen(records, { sections: {}, rail: null }, "records")).toBe(true);
    expect(isSectionOpen(payments, { sections: { payments: false }, rail: null }, null)).toBe(false);
  });
  it("forgets an override that matches the default again", () => {
    const open = toggleSection({ sections: {}, rail: null }, records, false);
    expect(open.sections).toEqual({ records: true });
    expect(toggleSection(open, records, true).sections).toEqual({});
  });
});
