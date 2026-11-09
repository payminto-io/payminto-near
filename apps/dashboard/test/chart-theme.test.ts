// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHART_TOKENS } from "@/lib/chart-theme";

const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");
const block = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf("}", start));
};

describe("chart theme tokens", () => {
  for (const [name, variable] of Object.entries(CHART_TOKENS)) {
    it(`${name} (${variable}) is an opaque colour in light and dark`, () => {
      for (const sel of [":root", ".dark"]) {
        const m = new RegExp(`${variable}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block(sel));
        expect(m, `${variable} missing in ${sel}`).not.toBeNull();
      }
    });
  }
  it("dark bars differ from the dark card background", () => {
    const bar = /--chart-bar:\s*(#[0-9a-f]{6})/i.exec(block(".dark"))![1];
    const card = /--card:\s*(#[0-9a-f]{6})/i.exec(block(".dark"))![1];
    expect(bar).not.toBe(card);
  });
});
