"use client";

import { Input } from "@/components/ui/input";
import type { ExpiryChoice } from "@/lib/gateway";
import { FormRow, Segmented } from "./kit";

/** When a payment link stops taking payments; after that it answers like an inactive link. */
export function ExpiryField({ choice, custom, onChoice, onCustom, error }: { choice: ExpiryChoice; custom: string; onChoice: (c: ExpiryChoice) => void; onCustom: (v: string) => void; error?: string | null }) {
  return (
    <FormRow id="l-expiry" label="Link expires" error={error} hint={choice === "never" ? "The link keeps taking payments until you turn it off." : "After this the link shows that it has expired and takes no payments."}>
      <div className="flex flex-col gap-2">
        <Segmented
          label="Link expires"
          value={choice}
          onChange={onChoice}
          className="w-full"
          options={[
            { key: "never", label: "Never" },
            { key: "24h", label: "24 hours" },
            { key: "7d", label: "7 days" },
            { key: "custom", label: "Custom" },
          ]}
        />
        {choice === "custom" && <Input id="l-expiry" type="datetime-local" value={custom} onChange={(e) => onCustom(e.target.value)} aria-invalid={Boolean(error)} />}
      </div>
    </FormRow>
  );
}
