"use client";

import { RequirePermission } from "@/components/app/states";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Loader2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { getAddress, isAddress, type Address } from "viem";
import { toAtomic } from "@payminto/protocol";
import { useApi } from "@/lib/session";
import { MOCK_MODE } from "@/lib/config";
import { chainIdOf, qk, useInfo, useProviders, useToken } from "@/lib/queries";
import { formatInt, formatMoney } from "@/lib/format";
import { hasInjectedWallet, parseAddressList, signWithDevKey, signWithEphemeral, signWithInjected, type MandateDraft } from "@/lib/sign";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Address as AddressView, Field, Fields, Money, PageHeader, Panel } from "@/components/app/primitives";
import { ErrorState } from "@/components/app/states";

const STEPS = ["Agent and budget", "Policy", "Review and sign"] as const;

type Form = {
  label: string;
  agent: string;
  totalCap: string;
  validDays: string;
  perCallCap: string;
  dailyCap: string;
  maxCallsPerMinute: string;
  purpose: string;
  payees: Address[];
  extraPayees: string;
};

const initial: Form = {
  label: "",
  agent: "",
  totalCap: "25",
  validDays: "30",
  perCallCap: "0.10",
  dailyCap: "5",
  maxCallsPerMinute: "120",
  purpose: "",
  payees: [],
  extraPayees: "",
};

function amount(v: string, decimals: number): bigint | null {
  try {
    if (!/^\d+(\.\d+)?$/.test(v.trim())) return null;
    return toAtomic(v.trim(), decimals);
  } catch {
    return null;
  }
}

function NewMandatePagePage() {
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const info = useInfo();
  const providers = useProviders();
  const token = useToken();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Form>(initial);
  const [touched, setTouched] = useState(false);
  const [signerChoice, setSigner] = useState<"wallet" | "dev" | "mock">(MOCK_MODE ? "mock" : "wallet");
  const [devKey, setDevKey] = useState("");
  const [busy, setBusy] = useState<null | "signing" | "submitting">(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const chainId = chainIdOf(info.data);
  // Without a browser wallet on the local chain, the development key is the only way to sign.
  const signer = signerChoice === "wallet" && !hasInjectedWallet() && chainId === 31337 ? "dev" : signerChoice;
  const extra = useMemo(() => parseAddressList(f.extraPayees), [f.extraPayees]);
  const allPayees = useMemo(() => [...new Set([...f.payees, ...extra.valid])], [f.payees, extra.valid]);

  const errors = useMemo(() => {
    const e: Partial<Record<keyof Form, string>> = {};
    const d = token.decimals;
    if (step === 0) {
      if (!f.label.trim()) e.label = "Give the budget a name you will recognise in Balances.";
      if (!isAddress(f.agent.trim())) e.agent = "Enter the agent wallet address (0x followed by 40 hex characters).";
      const cap = amount(f.totalCap, d);
      if (!cap || cap <= 0n) e.totalCap = `Enter a total cap in ${token.symbol}, for example 25.`;
      const days = Number(f.validDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) e.validDays = "Between 1 and 365 days.";
    }
    if (step === 1) {
      const cap = amount(f.totalCap, d) ?? 0n;
      const per = amount(f.perCallCap, d);
      const daily = amount(f.dailyCap, d);
      if (!per || per <= 0n) e.perCallCap = "Enter the largest price one charge may have.";
      else if (per > cap) e.perCallCap = "Cannot exceed the total limit.";
      if (!daily || daily <= 0n) e.dailyCap = "Enter a rolling 24 hour limit.";
      else if (daily > cap) e.dailyCap = "Cannot exceed the total limit.";
      else if (per && daily < per) e.dailyCap = "Must be at least the limit per charge.";
      const rpm = Number(f.maxCallsPerMinute);
      if (!Number.isInteger(rpm) || rpm < 0) e.maxCallsPerMinute = "A whole number; 0 turns the limit off.";
      if (!f.purpose.trim()) e.purpose = "Paid services and auditors see this. Say what the agent is for.";
      if (extra.invalid.length) e.extraPayees = `Not addresses: ${extra.invalid.slice(0, 3).join(", ")}`;
    }
    return e;
  }, [f, step, token, extra.invalid]);
  const valid = Object.keys(errors).length === 0;

  const draft = (): MandateDraft => ({
    agent: getAddress(f.agent.trim()),
    token: info.data!.token.address as Address,
    totalCap: amount(f.totalCap, token.decimals)!,
    validForSeconds: Number(f.validDays) * 86_400,
    payees: allPayees,
    policy: {
      perCallCap: amount(f.perCallCap, token.decimals)!.toString(),
      dailyCap: amount(f.dailyCap, token.decimals)!.toString(),
      maxCallsPerMinute: Number(f.maxCallsPerMinute),
      purpose: f.purpose.trim(),
    },
  });

  async function signAndSubmit() {
    if (!info.data) return;
    setError(null);
    setBusy("signing");
    try {
      const d = draft();
      const hub = info.data.hub as Address;
      const signed =
        signer === "wallet" ? await signWithInjected(chainId, hub, d) : signer === "dev" ? await signWithDevKey(chainId, hub, d, devKey) : await signWithEphemeral(chainId, hub, d);
      setBusy("submitting");
      const record = await api.createMandate({ mandate: signed.mandate, ownerSignature: signed.ownerSignature, policy: d.policy, payees: d.payees, label: f.label.trim() });
      await qc.invalidateQueries({ queryKey: qk.mandates });
      toast.success("Budget submitted", { description: "Your server is opening it on chain. It accepts charges once open." });
      router.push(`/mandates/${record.id}`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
      setError(/rejected|denied/i.test(msg) ? "The signature request was rejected in the wallet." : msg);
      setBusy(null);
    }
  }

  if (info.isError) return <ErrorState error={info.error} onRetry={() => void info.refetch()} />;

  return (
    <>
      <PageHeader
        back={{ href: "/mandates", label: "Budgets" }}
        title="New budget"
        description="You sign one EIP-712 message as the owner. Your server checks it and opens it on the settlement contract, paying the network fee itself."
      />
      <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "num flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                i < step ? "bg-positive-soft text-positive" : i === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {i < step ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn(i === step ? "font-medium" : "text-muted-foreground")}>{s}</span>
            {i < STEPS.length - 1 && <span aria-hidden className="mx-1 h-px w-6 bg-border sm:w-10" />}
          </li>
        ))}
      </ol>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (!valid) return;
              setTouched(false);
              if (step < 2) setStep(step + 1);
              else void signAndSubmit();
            }}
            className="flex flex-col gap-5"
          >
            {step === 0 && (
              <>
                <TextField id="label" label="Name" value={f.label} onChange={(v) => set("label", v)} error={touched ? errors.label : undefined} placeholder="Treasury Agent - Q4 research" />
                <TextField id="agent" label="Agent wallet" value={f.agent} onChange={(v) => set("agent", v)} error={touched ? errors.agent : undefined} placeholder="0x..." mono hint="The key that will sign charges. It needs the token and a one-time approve to the hub." />
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField id="totalCap" label="Total limit" unit={token.symbol} value={f.totalCap} onChange={(v) => set("totalCap", v)} error={touched ? errors.totalCap : undefined} inputMode="decimal" hint="Enforced on chain." />
                  <TextField id="validDays" label="Valid for" unit="days" value={f.validDays} onChange={(v) => set("validDays", v)} error={touched ? errors.validDays : undefined} inputMode="numeric" />
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <div className="grid gap-5 sm:grid-cols-3">
                  <TextField id="perCallCap" label="Limit per charge" unit={token.symbol} value={f.perCallCap} onChange={(v) => set("perCallCap", v)} error={touched ? errors.perCallCap : undefined} inputMode="decimal" />
                  <TextField id="dailyCap" label="Daily limit" unit={token.symbol} value={f.dailyCap} onChange={(v) => set("dailyCap", v)} error={touched ? errors.dailyCap : undefined} inputMode="decimal" />
                  <TextField id="rpm" label="Charges per minute" unit="per min" value={f.maxCallsPerMinute} onChange={(v) => set("maxCallsPerMinute", v)} error={touched ? errors.maxCallsPerMinute : undefined} inputMode="numeric" />
                </div>
                <TextField id="purpose" label="Purpose" value={f.purpose} onChange={(v) => set("purpose", v)} error={touched ? errors.purpose : undefined} placeholder="Research agent for the Q4 market report" />
                <fieldset>
                  <legend className="text-sm font-medium">Allowed services</legend>
                  <p className="mt-0.5 text-xs text-muted-foreground">Enforced on chain through a Merkle root. Leave everything unticked to allow any service.</p>
                  <div className="mt-3 divide-y rounded-lg border">
                    {(providers.data ?? []).map((p) => {
                      const on = f.payees.includes(p.payee as Address);
                      return (
                        <label key={p.id} className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-sm hover:bg-muted/40">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--primary)]"
                            checked={on}
                            onChange={() => set("payees", on ? f.payees.filter((x) => x !== p.payee) : [...f.payees, p.payee as Address])}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="font-medium">{p.name}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              <Money atomic={p.priceAtomic} /> per charge
                            </span>
                          </span>
                          <span className="hash text-xs text-subtle max-sm:hidden">{p.payee.slice(0, 8)}…{p.payee.slice(-4)}</span>
                        </label>
                      );
                    })}
                    {providers.data?.length === 0 && <p className="px-3.5 py-3 text-sm text-muted-foreground">No paid services registered on this server yet.</p>}
                  </div>
                  <div className="mt-3 space-y-1.5">
                    <Label htmlFor="extra" className="text-xs font-normal text-muted-foreground">
                      Other service addresses, one per line
                    </Label>
                    <Textarea id="extra" rows={2} className="hash text-sm" value={f.extraPayees} onChange={(e) => set("extraPayees", e.target.value)} aria-invalid={Boolean(touched && errors.extraPayees)} />
                    {touched && errors.extraPayees && <p className="text-xs text-negative">{errors.extraPayees}</p>}
                  </div>
                </fieldset>
              </>
            )}
            {step === 2 && (
              <>
                <fieldset>
                  <legend className="text-sm font-medium">Sign as owner with</legend>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {MOCK_MODE && (
                      <SignerOption checked={signer === "mock"} onSelect={() => setSigner("mock")} icon={<KeyRound className="size-4" />} title="Demo key" body="Mock mode: a throwaway key signs in this tab." />
                    )}
                    <SignerOption
                      checked={signer === "wallet"}
                      onSelect={() => setSigner("wallet")}
                      icon={<Wallet className="size-4" />}
                      title="Browser wallet"
                      body={hasInjectedWallet() ? "MetaMask, Rabby or any EIP-1193 wallet." : "No browser wallet detected in this browser."}
                      disabled={!hasInjectedWallet()}
                    />
                    {chainId === 31337 && (
                      <SignerOption checked={signer === "dev"} onSelect={() => setSigner("dev")} icon={<KeyRound className="size-4" />} title="Development key" body="Local test network only. The key stays in this tab." />
                    )}
                  </div>
                </fieldset>
                {signer === "dev" && chainId === 31337 && (
                  <TextField id="devkey" label="Owner private key" value={devKey} onChange={setDevKey} mono type="password" hint="A local test key. Never paste a key that holds real funds." />
                )}
                {error && (
                  <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
                    {error}
                  </p>
                )}
              </>
            )}
            <div className="flex items-center justify-between gap-3 border-t pt-5">
              {step > 0 ? (
                <Button type="button" variant="ghost" onClick={() => setStep(step - 1)} disabled={Boolean(busy)}>
                  Back
                </Button>
              ) : (
                <Button asChild variant="ghost">
                  <Link href="/mandates">Cancel</Link>
                </Button>
              )}
              <Button type="submit" disabled={Boolean(busy) || !info.data || (step === 2 && signer === "wallet" && !hasInjectedWallet())}>
                {busy && <Loader2 className="animate-spin" />}
                {step < 2 ? "Continue" : busy === "signing" ? "Waiting for signature" : busy === "submitting" ? "Submitting to server" : "Sign and submit"}
              </Button>
            </div>
          </form>
        </Panel>

        <Panel title="What the owner signs" description="EIP-712, domain Payminto Clearing v1" className="h-fit">
          <Fields className="gap-y-2.5">
            <Field label="Chain">{info.data ? `${info.data.network.name}, chain ${chainId}` : "-"}</Field>
            <Field label="Hub"><AddressView address={info.data?.hub} showName={false} /></Field>
            <Field label="Agent">{isAddress(f.agent.trim()) ? <AddressView address={getAddress(f.agent.trim())} showName={false} /> : <span className="text-subtle">Not set</span>}</Field>
            <Field label="Total limit">{amount(f.totalCap, token.decimals) ? <Money atomic={amount(f.totalCap, token.decimals)!} /> : "-"}</Field>
            <Field label="Per charge">{amount(f.perCallCap, token.decimals) ? <Money atomic={amount(f.perCallCap, token.decimals)!} /> : "-"}</Field>
            <Field label="Daily">{amount(f.dailyCap, token.decimals) ? <Money atomic={amount(f.dailyCap, token.decimals)!} /> : "-"}</Field>
            <Field label="Rate">{f.maxCallsPerMinute === "0" ? "No limit" : `${formatInt(Number(f.maxCallsPerMinute) || 0)} calls per minute`}</Field>
            <Field label="Expires">{Number(f.validDays) > 0 ? `in ${f.validDays} days` : "-"}</Field>
            <Field label="Services">{allPayees.length === 0 ? "Any service" : `${allPayees.length} allowed`}</Field>
          </Fields>
          <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">
            Total limit, validity and services are enforced by the hub on chain. Limit per charge, daily limit and rate limit are enforced by this server and committed on chain as a policy hash, so the
            agreed rules are provable. Worst case spend is capped at{" "}
            {amount(f.totalCap, token.decimals) ? `${formatMoney(amount(f.totalCap, token.decimals)!, token.decimals)} ${token.symbol}` : "the total limit"}.
          </p>
        </Panel>
      </div>
    </>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  unit,
  mono,
  placeholder,
  inputMode,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  unit?: string;
  mono?: boolean;
  placeholder?: string;
  inputMode?: "decimal" | "numeric";
  type?: string;
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          placeholder={placeholder}
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          className={cn(mono && "hash", unit && "num pr-16")}
        />
        {unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit}</span>}
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-negative">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function SignerOption({
  checked,
  onSelect,
  icon,
  title,
  body,
  disabled,
}: {
  checked: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-3 rounded-lg border p-3.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        checked ? "border-primary bg-accent/60" : "hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input type="radio" name="signer" className="sr-only" checked={checked} onChange={onSelect} disabled={disabled} />
      <span className={cn("mt-0.5", checked ? "text-primary" : "text-muted-foreground")}>{icon}</span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
    </label>
  );
}

export default function NewMandatePage() {
  return (
    <RequirePermission permission={"agents.manage"}>
      <NewMandatePagePage />
    </RequirePermission>
  );
}
