"use client";

import { RequirePermission } from "@/components/app/states";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Store } from "lucide-react";
import { getAddress, isAddress, type Address as Addr } from "viem";
import { toAtomic } from "@payminto/protocol";
import { useApi, useCan } from "@/lib/session";
import { qk, useProviders, useToken } from "@/lib/queries";
import { formatInt } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { Provider } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Address, CopyButton, Money, PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

function ProvidersPagePage() {
  return (
    <Suspense>
      <Providers />
    </Suspense>
  );
}

function Providers() {
  const providers = useProviders();
  const params = useSearchParams();
  const can = useCan();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep link from the first-run guide
    if (params.get("register") === "1") setOpen(true);
  }, [params]);

  const total = (providers.data ?? []).reduce((a, p) => a + BigInt(p.revenue?.settled ?? "0") + BigInt(p.revenue?.pending ?? "0"), 0n);

  return (
    <>
      <PageHeader
        title="Paid services"
        description="APIs, tools and agents that charge AI agents per call. Each one is paid straight into its own wallet when a settlement runs."
        actions={
          can("agents.manage") && (
            <Button onClick={() => setOpen(true)}>
              <Plus /> New paid service
            </Button>
          )
        }
      />
      <Panel bodyClassName="p-0 sm:p-0">
        {providers.isPending ? (
          <RowsSkeleton className="px-5" rows={3} />
        ) : providers.isError ? (
          <ErrorState className="m-4" error={providers.error} onRetry={() => void providers.refetch()} />
        ) : providers.data.length === 0 ? (
          <EmptyState icon={<Store className="size-4" />} title="No paid services yet" action={can("agents.manage") ? <Button onClick={() => setOpen(true)}>Add the first paid service</Button> : undefined}>
            A paid service puts a paywall in front of its endpoint and forwards each charge to this server for checking.
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {providers.data.map((p) => (
              <ProviderRow key={p.id} p={p} total={total} />
            ))}
          </ul>
        )}
      </Panel>
      <RegisterDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function ProviderRow({ p, total }: { p: Provider; total: bigint }) {
  const settled = BigInt(p.revenue?.settled ?? "0");
  const pending = BigInt(p.revenue?.pending ?? "0");
  const share = (v: bigint) => (total > 0n ? Number((v * 10000n) / total) / 100 : 0);
  return (
    <li className="grid gap-4 px-4 py-5 sm:px-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)] lg:items-center lg:gap-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{p.name}</h3>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{p.category}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
        <p className="hash mt-1.5 truncate text-xs text-subtle" title={p.resource}>
          {p.resource}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-1 lg:gap-2">
        <div>
          <dt className="text-xs text-muted-foreground">Price</dt>
          <dd className="font-medium">
            <Money atomic={p.priceAtomic} /> <span className="text-xs font-normal text-muted-foreground">per charge</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Service wallet</dt>
          <dd>
            <Address address={p.payee} showName={false} />
          </dd>
        </div>
      </dl>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="text-xs text-muted-foreground">Revenue</span>
          <Money atomic={settled + pending} maxFraction={4} className="font-semibold" />
        </div>
        <div className="mt-2 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="h-full rounded-l-full bg-positive" style={{ width: `${share(settled)}%` }} />
          <span className="h-full bg-warning" style={{ width: `${share(pending)}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-positive" /> Settled <Money atomic={settled} maxFraction={4} className="text-foreground" />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-warning" /> Pending <Money atomic={pending} maxFraction={4} className="text-foreground" />
          </span>
        </div>
        <p className="num mt-1 text-xs text-subtle">{formatInt(p.calls24h)} calls in the last 24h</p>
      </div>
    </li>
  );
}

function RegisterDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const token = useToken();
  const [form, setForm] = useState({ name: "", description: "", payee: "", price: "0.01", resource: "", category: "Data" });
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<{ id: string; apiKey: string } | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  let priceAtomic: bigint | null = null;
  try {
    priceAtomic = /^\d+(\.\d+)?$/.test(form.price) ? toAtomic(form.price, token.decimals) : null;
  } catch {
    priceAtomic = null;
  }
  const errors = {
    name: form.name.trim() ? null : "Required.",
    payee: isAddress(form.payee.trim()) ? null : "Enter the wallet that receives payouts.",
    price: priceAtomic && priceAtomic > 0n ? null : `A price in ${token.symbol}, for example 0.01.`,
    resource: /^https?:\/\//.test(form.resource.trim()) ? null : "The URL agents call, starting with http.",
  };
  const valid = Object.values(errors).every((e) => !e);

  const create = useMutation({
    mutationFn: () =>
      api.createProvider({
        name: form.name.trim(),
        description: form.description.trim(),
        payee: getAddress(form.payee.trim()) as Addr,
        priceAtomic: priceAtomic!.toString(),
        resource: form.resource.trim(),
        category: form.category.trim() || "Other",
      }),
    onSuccess: (res) => {
      setCreated(res);
      void qc.invalidateQueries({ queryKey: qk.providers });
    },
  });

  function close(v: boolean) {
    onOpenChange(v);
    if (!v) {
      setCreated(null);
      setTouched(false);
      create.reset();
      setForm({ name: "", description: "", payee: "", price: "0.01", resource: "", category: "Data" });
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (valid) create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Paid service registered</DialogTitle>
              <DialogDescription>Copy the API key now. It is stored hashed on the server and will not be shown again.</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="size-3.5" /> API key for {created.id}
              </p>
              <div className="flex items-center gap-2">
                <code className="hash min-w-0 flex-1 rounded-md bg-card px-2.5 py-2 text-sm break-all">{created.apiKey}</code>
                <CopyButton value={created.apiKey} label="API key" className="size-8" />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Give it to the paid service as its paywall key. It authorises charge checks for this paid service only.
            </p>
            <DialogFooter>
              <Button onClick={() => close(false)}>I saved the key</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>New paid service</DialogTitle>
              <DialogDescription>Agents pay this service per call; the money goes straight to its wallet.</DialogDescription>
            </DialogHeader>
            <FormRow id="p-name" label="Name" error={touched ? errors.name : null}>
              <Input id="p-name" value={form.name} onChange={set("name")} placeholder="Market Data" aria-invalid={Boolean(touched && errors.name)} />
            </FormRow>
            <FormRow id="p-desc" label="Description">
              <Textarea id="p-desc" rows={2} value={form.description} onChange={set("description")} placeholder="What one paid call returns" />
            </FormRow>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormRow id="p-price" label="Price per charge" error={touched ? errors.price : null}>
                <div className="relative">
                  <Input id="p-price" inputMode="decimal" value={form.price} onChange={set("price")} className="num pr-14" aria-invalid={Boolean(touched && errors.price)} />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{token.symbol}</span>
                </div>
              </FormRow>
              <FormRow id="p-cat" label="Category">
                <Input id="p-cat" value={form.category} onChange={set("category")} />
              </FormRow>
            </div>
            <FormRow id="p-payee" label="Service wallet" error={touched ? errors.payee : null}>
              <Input id="p-payee" value={form.payee} onChange={set("payee")} placeholder="0x..." className="hash" aria-invalid={Boolean(touched && errors.payee)} />
            </FormRow>
            <FormRow id="p-res" label="Resource URL" error={touched ? errors.resource : null}>
              <Input id="p-res" value={form.resource} onChange={set("resource")} placeholder="https://api.example.com/quote" className="hash" aria-invalid={Boolean(touched && errors.resource)} />
            </FormRow>
            {create.isError && (
              <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
                {create.error instanceof ApiError ? create.error.message : "Registration failed."}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Loader2 className="animate-spin" />} Register provider
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FormRow({ id, label, error, children }: { id: string; label: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}

export default function ProvidersPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <ProvidersPagePage />
    </RequirePermission>
  );
}
