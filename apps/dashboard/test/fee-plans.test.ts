import { describe, expect, it } from "vitest";
import { EXAMPLE_AMOUNT, exampleFee, planDraft, planPatch, validatePlan, type PlanDraft } from "@/lib/fee-plans";

const draft = (over: Partial<PlanDraft> = {}): PlanDraft => ({ name: "Standard", percent: "1", fixed: "", min: "", max: "", ...over });

describe("validatePlan", () => {
  it("turns the form into the body the server takes", () => {
    expect(validatePlan(draft({ percent: "0.5", fixed: "0.10", min: "0.05", max: "2" }), 6)).toEqual({
      ok: true,
      body: { name: "Standard", platform_fee_bps: 50, platform_fee_fixed: "100000", min_fee: "50000", max_fee: "2000000" },
    });
    expect(validatePlan(draft({ name: "  Free  ", percent: "0" }), 6)).toEqual({ ok: true, body: { name: "Free", platform_fee_bps: 0, platform_fee_fixed: "0", min_fee: "0", max_fee: null } });
  });

  it("names every field that is wrong, in plain words", () => {
    const r = validatePlan(draft({ name: " ", percent: "12", fixed: "abc", min: "0.0000001", max: "-1" }), 6);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual({
      name: "Give the plan a name.",
      percent: "A percentage from 0 to 10, with at most 2 decimals.",
      fixed: "An amount like 0.25, with at most 6 decimals.",
      min: "An amount like 0.25, with at most 6 decimals.",
      max: "An amount like 0.25, with at most 6 decimals.",
    });
  });

  it("refuses a most below the least, and an empty percent", () => {
    const r = validatePlan(draft({ percent: "", min: "1", max: "0.5" }), 6);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual({ percent: "A percentage from 0 to 10, with at most 2 decimals.", max: "Must be at least the minimum fee." });
  });

  it("keeps names to 120 characters", () => {
    const r = validatePlan(draft({ name: "x".repeat(121) }), 6);
    expect(r.ok ? null : r.errors.name).toBe("At most 120 characters.");
  });
});

describe("exampleFee on 25 USDC", () => {
  it("applies percent, fixed fee, minimum and maximum like the server", () => {
    expect(EXAMPLE_AMOUNT).toBe(25_000_000n);
    expect(exampleFee({ platform_fee_bps: 100, platform_fee_fixed: "0", min_fee: null, max_fee: null })).toEqual({ fee: 250_000n, receives: 24_750_000n });
    expect(exampleFee({ platform_fee_bps: 50, platform_fee_fixed: "100000", min_fee: "0", max_fee: null })).toEqual({ fee: 225_000n, receives: 24_775_000n });
    expect(exampleFee({ platform_fee_bps: 10, platform_fee_fixed: "0", min_fee: "500000", max_fee: null })?.fee).toBe(500_000n);
    expect(exampleFee({ platform_fee_bps: 1000, platform_fee_fixed: "0", min_fee: "0", max_fee: "1000000" })?.fee).toBe(1_000_000n);
    expect(exampleFee({ platform_fee_bps: 0, platform_fee_fixed: "0", min_fee: null, max_fee: null })).toEqual({ fee: 0n, receives: 25_000_000n });
  });
  it("is null for a plan the server would refuse", () => {
    expect(exampleFee({ platform_fee_bps: 10, platform_fee_fixed: "0", min_fee: "2", max_fee: "1" })).toBeNull();
  });
});

describe("planDraft and planPatch", () => {
  const plan = { id: "fp_1", name: "Standard", platform_fee_bps: 50, platform_fee_fixed: "100000", min_fee: "0", max_fee: null, created_at: "2026-11-01T00:00:00.000Z" };
  it("fills the form from a plan", () => {
    expect(planDraft(plan, 6)).toEqual({ name: "Standard", percent: "0.5", fixed: "0.10", min: "", max: "" });
    expect(planDraft(null, 6)).toEqual({ name: "", percent: "", fixed: "", min: "", max: "" });
  });
  it("sends only what changed", () => {
    expect(planPatch(plan, { name: "Standard", platform_fee_bps: 75, platform_fee_fixed: "100000", min_fee: "0", max_fee: null })).toEqual({ platform_fee_bps: 75 });
    expect(planPatch(plan, { name: "Pro", platform_fee_bps: 50, platform_fee_fixed: "100000", min_fee: "0", max_fee: "5000000" })).toEqual({ name: "Pro", max_fee: "5000000" });
    expect(planPatch(plan, { name: "Standard", platform_fee_bps: 50, platform_fee_fixed: "100000", min_fee: "0", max_fee: null })).toEqual({});
  });
});
