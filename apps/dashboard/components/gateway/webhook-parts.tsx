"use client";

import { WEBHOOK_EVENT_TYPES, type WebhookEndpoint } from "@/lib/schemas";

export function endpointStatus(e: WebhookEndpoint): { tone: "positive" | "neutral" | "negative"; label: string } {
  if (!e.active) return e.disabled_reason ? { tone: "negative", label: "Disabled" } : { tone: "neutral", label: "Paused" };
  if (e.success_rate_7d != null && e.success_rate_7d < 0.9) return { tone: "negative", label: "Failing" };
  return { tone: "positive", label: "Enabled" };
}

const GROUPS: { label: string; events: string[] }[] = [
  { label: "Payments", events: WEBHOOK_EVENT_TYPES.filter((e) => e.startsWith("payment.")) },
  { label: "Refunds", events: WEBHOOK_EVENT_TYPES.filter((e) => e.startsWith("refund.")) },
];

export function EventPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const all = value.includes("*");
  const toggle = (e: string) => onChange(value.includes(e) ? value.filter((x) => x !== e) : [...value.filter((x) => x !== "*"), e]);
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">Events</legend>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={all} onChange={() => onChange(all ? [] : ["*"])} className="size-4 accent-primary" />
        All events, including ones added later
      </label>
      {!all &&
        GROUPS.map((g) => (
          <div key={g.label} className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{g.label}</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {g.events.map((e) => (
                <label key={e} className="hash flex items-center gap-2 text-[0.8125rem]">
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

