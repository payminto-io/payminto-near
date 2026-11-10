"use client";

import { useState, type ReactNode } from "react";
import { computeFees } from "@payminto/protocol";
import { FileSignature, Wallet } from "lucide-react";
import { useToken } from "@/lib/queries";
import { formatBps, parseAmountInput, parsePercentToBps, plainAmount } from "@/lib/gateway";
import { formatToken } from "@/lib/format";
import type { MerchantMethod, PaymentMethod } from "@/lib/schemas";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Segmented, Unit } from "@/components/gateway/kit";

export type MethodRow = Omit<MerchantMethod, "merchant_id">;

export const METHOD_INFO: Record<PaymentMethod, { label: string; hint: string; icon: typeof Wallet }> = {
  wallet: { label: "Pay with a NEAR wallet", hint: "The customer approves one transfer to the hub from any NEAR wallet.", icon: Wallet },
  voucher: { label: "AI agent with a Budget", hint: "An agent pays per Call from a Budget its owner opened on the hub.", icon: FileSignature },
};

export const DEFAULT_METHODS: MethodRow[] = (["wallet", "voucher"] as const).map((method) => ({
  method,
  enabled: true,
  fee_bps: 0,
  fee_fixed: "0",
  bearer: "merchant",
  min_amount: null,
  max_amount: null,
}));

/** "Free", "0.25%", "0.10 USDC" or "0.25% + 0.10 USDC", in Square's fee style. */
export function methodFeeText(r: Pick<MethodRow, "fee_bps" | "fee_fixed">, t: { symbol: string; decimals: number }): string {
  const fixed = BigInt(r.fee_fixed);
  if (r.fee_bps === 0 && fixed === 0n) return "No method fee";
  return [r.fee_bps ? formatBps(r.fee_bps) : null, fixed ? formatToken(fixed, t.symbol, t.decimals) : null].filter(Boolean).join(" + ");
}

/**
 * Payment method rows: a switch, the fee and who pays it. The platform sets fees; a business only switches methods on
 * and off and sees the fees the platform set.
 */
export function MethodsEditor({
  rows,
  onChange,
  editableFees,
  readOnly = false,
  notes = {},
}: {
  rows: MethodRow[];
  onChange: (rows: MethodRow[]) => void;
  editableFees: boolean;
  readOnly?: boolean;
  /** A status line under a method. */
  notes?: Partial<Record<MethodRow["method"], ReactNode>>;
}) {
  const t = useToken();
  const set = (i: number, patch: Partial<MethodRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <ul className="divide-y rounded-lg border">
      {rows.map((r, i) => {
        const info = METHOD_INFO[r.method];
        const Icon = info.icon;
        return (
          <li key={r.method} className="flex flex-col gap-3 p-3 sm:p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Icon className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <label htmlFor={`m-${r.method}`} className="text-sm font-medium">
                  {info.label}
                </label>
                <p className="text-xs text-muted-foreground">{info.hint}</p>
                {notes[r.method] && <div className="mt-1 text-xs">{notes[r.method]}</div>}
                {!editableFees && (
                  <p className="mt-1 text-xs">
                    {methodFeeText(r, t)}
                    {(r.fee_bps > 0 || BigInt(r.fee_fixed) > 0n) && <span className="text-muted-foreground">, {r.bearer === "customer" ? "paid by the customer at checkout" : "deducted from your payout"}</span>}
                  </p>
                )}
              </div>
              <Switch id={`m-${r.method}`} checked={r.enabled} disabled={readOnly} onCheckedChange={(enabled) => set(i, { enabled })} />
            </div>
            {editableFees && r.enabled && <FeeInputs row={r} label={info.label} onChange={(patch) => set(i, patch)} symbol={t.symbol} decimals={t.decimals} />}
          </li>
        );
      })}
    </ul>
  );
}

const SAMPLE = 25_000_000n;

/** One sample payment for the bearer switch (Zillow "costs and fees"): what the customer pays, or what comes off the payout. */
function bearerExample(row: MethodRow, symbol: string, decimals: number): string | null {
  let fee = 0n;
  try {
    fee = computeFees({ amount: SAMPLE, plan: { platform_fee_bps: 0, platform_fee_fixed: "0" }, method: row }).method_fee;
  } catch {
    return null;
  }
  if (fee === 0n) return null;
  const f = (v: bigint) => formatToken(v, symbol, decimals);
  return row.bearer === "customer"
    ? `On a ${f(SAMPLE)} price the customer pays ${f(SAMPLE + fee)}, shown as a separate line at checkout.`
    : `On a ${f(SAMPLE)} payment, ${f(fee)} comes off the business's payout.`;
}

function FeeInputs({ row, label, onChange, symbol, decimals }: { row: MethodRow; label: string; onChange: (p: Partial<MethodRow>) => void; symbol: string; decimals: number }) {
  const [pct, setPct] = useState(String(row.fee_bps / 100));
  const [fixed, setFixed] = useState(BigInt(row.fee_fixed) > 0n ? plainAmount(row.fee_fixed, decimals) : "");
  const pctBad = parsePercentToBps(pct, 10_000) === null;
  const example = bearerExample(row, symbol, decimals);
  return (
    <div className="grid gap-2 pl-11 sm:grid-cols-[7rem_8.5rem_1fr] sm:items-center">
      <p className="text-xs font-medium text-muted-foreground sm:col-span-3">Extra fee for this way of paying (percent and fixed), and who pays it</p>
      <Unit unit="%">
        <Input
          aria-label={`${label} fee percent`}
          inputMode="decimal"
          value={pct}
          aria-invalid={pctBad}
          onChange={(e) => {
            setPct(e.target.value);
            const b = parsePercentToBps(e.target.value, 10_000);
            if (b !== null) onChange({ fee_bps: b });
          }}
          className="num h-8 pr-8"
        />
      </Unit>
      <Unit unit={symbol}>
        <Input
          aria-label={`${label} fixed fee`}
          inputMode="decimal"
          value={fixed}
          placeholder="0.00"
          onChange={(e) => {
            setFixed(e.target.value);
            const p = e.target.value.trim() ? parseAmountInput(e.target.value, decimals) : ({ ok: true, atomic: 0n } as const);
            if (p.ok) onChange({ fee_fixed: p.atomic.toString() });
          }}
          className="num h-8 pr-14"
        />
      </Unit>
      <Segmented
        label={`Who pays the ${label} fee`}
        value={row.bearer}
        onChange={(bearer) => onChange({ bearer })}
        options={[
          { key: "merchant", label: "Business pays" },
          { key: "customer", label: "Customer pays" },
        ]}
      />
      {example && <p className="text-xs text-muted-foreground sm:col-span-3">{example}</p>}
    </div>
  );
}
