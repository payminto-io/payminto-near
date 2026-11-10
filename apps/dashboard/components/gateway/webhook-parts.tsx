"use client";

import { z } from "zod";
import { WEBHOOK_EVENT_TYPES, denialSchema, type Denial, type WebhookEndpoint } from "@/lib/schemas";
import type { WebhookScope } from "@/lib/gateway-api";
import type { Permission } from "@/lib/permissions";
import { DenialItem } from "@/components/app/denial";

export function endpointStatus(e: WebhookEndpoint): { tone: "positive" | "neutral" | "negative"; label: string } {
  if (!e.active) return e.disabled_reason ? { tone: "negative", label: "Disabled" } : { tone: "neutral", label: "Paused" };
  if (e.success_rate_7d != null && e.success_rate_7d < 0.9) return { tone: "negative", label: "Failing" };
  return { tone: "positive", label: "Enabled" };
}

type ScopeInfo = {
  /** Where the list lives; detail pages are `${base}/{id}`. */
  base: string;
  title: string;
  description: string;
  empty: string;
  placeholder: string;
  /** Who may add, change and retry. Reading follows the route's own permission. */
  manage: Permission;
  defaultEvents: string[];
  groups: { label: string; events: string[] }[];
  /** False when every event is listed, so "All events" would only hide the choice. */
  allowAll: boolean;
};

const REFUSALS = { label: "Refused agent payments", events: ["budget.refused"] };

/**
 * The two webhook scopes. A business endpoint hears its payments, refunds and the refusals of agent payments to that
 * business; a platform endpoint hears every refusal on this server (`budget.refused`), for on-call alerting.
 */
export const WEBHOOK_SCOPES: Record<WebhookScope, ScopeInfo> = {
  business: {
    base: "/developers/webhooks",
    title: "Webhooks",
    description: "Signed HTTP callbacks for payment, refund and refusal events. Every attempt is logged with its status code and can be retried.",
    empty: "Your server learns about paid payments here instead of polling.",
    placeholder: "Order fulfilment",
    manage: "developers.manage",
    defaultEvents: ["payment.paid", "payment.overpaid", "payment.underpaid", "refund.succeeded"],
    groups: [
      { label: "Payments", events: WEBHOOK_EVENT_TYPES.filter((e) => e.startsWith("payment.")) },
      { label: "Refunds", events: WEBHOOK_EVENT_TYPES.filter((e) => e.startsWith("refund.")) },
      REFUSALS,
    ],
    allowAll: true,
  },
  platform: {
    base: "/platform/webhooks",
    title: "Refusal alerts",
    description:
      "Signed HTTP callbacks for every agent payment this server refuses (budget.refused): the rule, the attempted amount, what is left of the Budget and how to retry. No money moved in any of them.",
    empty: "Point your on-call tool here to hear about refused agent payments as they happen.",
    placeholder: "On-call alerts",
    manage: "agents.manage",
    defaultEvents: ["budget.refused"],
    groups: [REFUSALS],
    allowAll: false,
  },
};

export function EventPicker({ scope = "business", value, onChange }: { scope?: WebhookScope; value: string[]; onChange: (v: string[]) => void }) {
  const info = WEBHOOK_SCOPES[scope];
  const all = info.allowAll && value.includes("*");
  const toggle = (e: string) => onChange(value.includes(e) ? value.filter((x) => x !== e) : [...value.filter((x) => x !== "*"), e]);
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">Events</legend>
      {info.allowAll && (
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={all} onChange={() => onChange(all ? [] : ["*"])} className="size-4 accent-primary" />
          All events, including ones added later
        </label>
      )}
      {!all &&
        info.groups.map((g) => (
          <div key={g.label} className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{g.label}</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {g.events.map((e) => (
                <label key={e} className="hash flex min-h-8 items-center gap-2 text-[0.8125rem]">
                  <input type="checkbox" checked={value.includes(e)} onChange={() => toggle(e)} className="size-4 accent-primary" />
                  {e}
                </label>
              ))}
            </div>
          </div>
        ))}
    </fieldset>
  );
}

const refusalBody = z.object({
  data: z.object({
    object: z.object({
      id: z.string(),
      rule: z.string(),
      message: z.string(),
      budget_id: z.string().optional(),
      agent: z.string().nullable().optional(),
      payee: z.string().optional(),
      provider_id: z.string().optional(),
      attempted_amount: z.string().optional(),
      remaining_budget: z.string().nullable().optional(),
      retry: z.unknown().optional(),
      created_at: z.string(),
    }),
  }),
});

/** A `budget.refused` delivery read as the Refusal it carries, above the raw payload. */
export function RefusalPayload({ body }: { body: string }) {
  const denial = refusalDenialOf(body);
  if (!denial) return null;
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">What this alert says</p>
      <div className="rounded-lg border">
        <DenialItem as="div" denial={denial} />
      </div>
    </div>
  );
}

/** The Denial a `budget.refused` payload describes, or null for any other body. */
export function refusalDenialOf(body: string): Denial | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const r = refusalBody.safeParse(json);
  if (!r.success) return null;
  const o = r.data.data.object;
  const d = denialSchema.safeParse({
    id: o.id,
    rule: o.rule,
    message: o.message,
    budgetId: o.budget_id || null,
    agent: o.agent ?? null,
    payee: o.payee || null,
    providerId: o.provider_id || null,
    amount: o.attempted_amount ?? null,
    createdAt: o.created_at,
    details: { refusal: { rule: o.rule, message: o.message, attemptedAmount: o.attempted_amount ?? "0", remainingBudget: o.remaining_budget ?? null, retry: o.retry } },
  });
  return d.success ? d.data : null;
}
