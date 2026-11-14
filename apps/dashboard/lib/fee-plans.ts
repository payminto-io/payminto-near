/**
 * Pricing plans for the platform owner: the form's text turned into the body `POST /v1/fee-plans` takes, with the
 * same limits the server checks, and the fee on a sample payment worked out with the protocol's own computeFees.
 */
import { computeFees, toAtomic } from "@payminto/protocol";
import type { FeePlanBody } from "./operator-api";
import type { FeePlan } from "./schemas";
import { parsePercentToBps, plainAmount } from "./gateway";

/** The sample payment every plan is shown on, as FeePreview does: 25 USDC. */
export const EXAMPLE_AMOUNT = 25_000_000n;
/** The server's limit on the platform fee: 10%. */
export const MAX_PLAN_BPS = 1000;
const NAME_MAX = 120;

export type PlanDraft = { name: string; percent: string; fixed: string; min: string; max: string };
export type PlanErrors = Partial<Record<keyof PlanDraft, string>>;

const PERCENT_ERROR = "A percentage from 0 to 10, with at most 2 decimals.";

/** A fee amount: blank is `fallback`, else a non-negative decimal with at most `decimals` places. */
function amountOf(text: string, decimals: number): bigint | "blank" | null {
  const t = text.trim().replace(/,/g, "");
  if (!t) return "blank";
  if (!/^\d*\.?\d*$/.test(t) || t === ".") return null;
  const frac = t.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  return toAtomic(`${t.startsWith(".") ? "0" : ""}${t.endsWith(".") ? t.slice(0, -1) : t}`, decimals);
}

export function validatePlan(d: PlanDraft, decimals: number): { ok: true; body: FeePlanBody } | { ok: false; errors: PlanErrors } {
  const errors: PlanErrors = {};
  const name = d.name.trim();
  if (!name) errors.name = "Give the plan a name.";
  else if (name.length > NAME_MAX) errors.name = `At most ${NAME_MAX} characters.`;
  const bps = parsePercentToBps(d.percent, MAX_PLAN_BPS);
  if (bps === null) errors.percent = PERCENT_ERROR;
  const amountError = `An amount like 0.25, with at most ${decimals} decimals.`;
  const fixed = amountOf(d.fixed, decimals);
  const min = amountOf(d.min, decimals);
  const max = amountOf(d.max, decimals);
  if (fixed === null) errors.fixed = amountError;
  if (min === null) errors.min = amountError;
  if (max === null) errors.max = amountError;
  const minV = min === "blank" ? 0n : min;
  const maxV = max === "blank" ? null : max;
  if (!errors.max && !errors.min && maxV !== null && minV !== null && maxV < minV) errors.max = "Must be at least the minimum fee.";
  if (Object.keys(errors).length > 0 || bps === null || fixed === null || minV === null) return { ok: false, errors };
  return {
    ok: true,
    body: { name, platform_fee_bps: bps, platform_fee_fixed: (fixed === "blank" ? 0n : fixed).toString(), min_fee: minV.toString(), max_fee: maxV === null ? null : maxV.toString() },
  };
}

/** The platform fee on the sample payment and what the business keeps of it; null for a plan the server would refuse. */
export function exampleFee(plan: Pick<FeePlan, "platform_fee_bps" | "platform_fee_fixed" | "min_fee" | "max_fee">, amount = EXAMPLE_AMOUNT): { fee: bigint; receives: bigint } | null {
  try {
    const f = computeFees({ amount, plan, method: null });
    return { fee: f.platform_fee, receives: f.net_amount };
  } catch {
    return null;
  }
}

/** The form for a plan (blank for a new one). Zero minimums and fixed fees show as blank, the way they are typed. */
export function planDraft(plan: Pick<FeePlan, "name" | "platform_fee_bps" | "platform_fee_fixed" | "min_fee" | "max_fee"> | null, decimals: number): PlanDraft {
  if (!plan) return { name: "", percent: "", fixed: "", min: "", max: "" };
  const amount = (v: string | null) => (v === null || BigInt(v) === 0n ? "" : plainAmount(v, decimals));
  return { name: plan.name, percent: String(plan.platform_fee_bps / 100), fixed: amount(plan.platform_fee_fixed), min: amount(plan.min_fee), max: plan.max_fee === null ? "" : plainAmount(plan.max_fee, decimals) };
}

/** Only the fields that changed, so an edit never rewrites what it did not touch. */
export function planPatch(plan: Pick<FeePlan, "name" | "platform_fee_bps" | "platform_fee_fixed" | "min_fee" | "max_fee">, body: FeePlanBody): Partial<FeePlanBody> {
  const out: Partial<FeePlanBody> = {};
  if (body.name !== plan.name) out.name = body.name;
  if (body.platform_fee_bps !== plan.platform_fee_bps) out.platform_fee_bps = body.platform_fee_bps;
  if (BigInt(body.platform_fee_fixed) !== BigInt(plan.platform_fee_fixed)) out.platform_fee_fixed = body.platform_fee_fixed;
  if (BigInt(body.min_fee ?? "0") !== BigInt(plan.min_fee ?? "0")) out.min_fee = body.min_fee;
  if ((body.max_fee ?? null) !== (plan.max_fee ?? null) && !(body.max_fee !== null && plan.max_fee !== null && BigInt(body.max_fee) === BigInt(plan.max_fee))) out.max_fee = body.max_fee;
  return out;
}
