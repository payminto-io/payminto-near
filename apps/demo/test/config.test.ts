import { describe, expect, it } from "vitest";
import { createHub } from "../src/chain.ts";
import { DemoConfigError, loadDemoConfig } from "../src/config.ts";

describe("demo configuration", () => {
  it("defaults to the labeled simulated hub at full scale", async () => {
    expect(loadDemoConfig({})).toMatchObject({ chain: "fake", scale: 1, timeoutSec: 120, keep: false });
    expect(loadDemoConfig({ DEMO_CHAIN: "sandbox", DEMO_SCALE: "0.5" })).toMatchObject({ chain: "sandbox", scale: 0.5, timeoutSec: 600 });
    expect(loadDemoConfig({ DEMO_CHAIN: "sandbox" }, ["run", "--chain", "fake", "--scale", "2"])).toMatchObject({ chain: "fake", scale: 2 });
    expect(loadDemoConfig({}, ["--chain=sandbox", "--timeout", "900", "--keep"])).toMatchObject({ chain: "sandbox", timeoutSec: 900, keep: true });
    expect(loadDemoConfig({ DEMO_TIMEOUT_SEC: "30" })).toMatchObject({ timeoutSec: 30 });
    expect((await createHub("fake")).label).toMatch(/^SIMULATED/);
  });

  it("refuses what it cannot run", () => {
    expect(() => loadDemoConfig({}, ["--chain", "near:mainnet"])).toThrow(DemoConfigError);
    expect(() => loadDemoConfig({}, ["--chain"])).toThrow(/needs a value/);
    expect(() => loadDemoConfig({}, ["--fast"])).toThrow(/unknown argument/);
    expect(() => loadDemoConfig({ DEMO_SCALE: "0" })).toThrow(/scale/);
    expect(() => loadDemoConfig({}, ["--timeout", "2"])).toThrow(/timeout/);
    expect(() => loadDemoConfig({}, ["--keep"])).toThrow(/only applies to --chain sandbox/);
  });

  it("needs a run directory and the node's checkout key for a sandbox hub", async () => {
    await expect(createHub("sandbox")).rejects.toThrow(/run directory/);
  });
});
