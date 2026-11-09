"use client";

/**
 * Add, edit and rotate-key dialogs for AI connections (docs/AGENTS.md sections 2 and 7). The key field is a password
 * field that is never prefilled, never stored in the page and cleared when the dialog closes; the server keeps it
 * encrypted and only ever returns its last four characters.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useApi } from "@/lib/session";
import { ak, useAiModels, useAiProviders, useBusinessId } from "@/lib/agents-queries";
import { providerName, shortProviderName } from "@/lib/agents";
import type { AiConnection, AiProvider } from "@/lib/schemas";
import type { CreateConnectionBody, UpdateConnectionBody } from "@/lib/agents-api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormRow } from "@/components/gateway/kit";

/** A whole number of tokens from the limit field: null for empty (no limit), NaN when it is not a number. */
export function parseTokenLimit(raw: string): number | null {
  const t = raw.replace(/[,_\s]/g, "");
  if (!t) return null;
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : Number.NaN;
}

function baseUrlError(url: string, required: boolean): string | null {
  const u = url.trim();
  if (!u) return required ? "This provider needs a base URL." : null;
  if (/^https:\/\/[^/\s]+/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u)) return null;
  return "Use an https:// address.";
}

/** Model ids as clickable suggestions under the model field: the provider's own list when there is one. */
export function ModelSuggestions({ models, value, onPick, loading }: { models: string[]; value: string; onPick: (m: string) => void; loading?: boolean }) {
  if (loading) return <p className="text-xs text-muted-foreground">Reading models from the provider...</p>;
  if (models.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested models">
      {models.slice(0, 8).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onPick(m)}
          aria-pressed={value === m}
          className={cn(
            "hash h-6 rounded-md border px-1.5 text-[0.75rem] transition-colors duration-150 focus-visible:outline-2",
            value === m ? "border-primary bg-accent text-accent-foreground" : "bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function KeyField({ id, value, onChange, error, provider }: { id: string; value: string; onChange: (v: string) => void; error?: string | null; provider: string }) {
  return (
    <FormRow id={id} label="API key" error={error} hint={`From your ${provider} account. Stored encrypted; Payminto shows only its last 4 characters after this.`}>
      <Input id={id} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} className="hash" aria-invalid={Boolean(error)} />
    </FormRow>
  );
}

function useRefresh() {
  const qc = useQueryClient();
  const b = useBusinessId();
  return () => {
    void qc.invalidateQueries({ queryKey: ak.connections(b) });
    void qc.invalidateQueries({ queryKey: ["agents", b, "models"] });
  };
}

/** Tells the person what the provider said about a key it was just given. */
function reportVerdict(c: AiConnection, providers: AiProvider[] | undefined, saved: string) {
  if (c.status === "invalid") toast.error(`${saved}, but ${providerName(c.provider, providers)} rejected the key. ${c.last_error ?? ""} Rotate the key to fix it.`.trim(), { duration: 8000 });
  else toast.success(`${saved}. ${providerName(c.provider, providers)} accepted the key.`);
}

// ---------------------------------------------------------------------------
// Add and edit
// ---------------------------------------------------------------------------

export function ConnectionDialog({ open, onOpenChange, connection }: { open: boolean; onOpenChange: (open: boolean) => void; connection?: AiConnection | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[30rem]">{open && <ConnectionForm connection={connection ?? null} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function ConnectionForm({ connection, onDone }: { connection: AiConnection | null; onDone: () => void }) {
  const api = useApi();
  const providers = useAiProviders();
  const refresh = useRefresh();
  const editing = Boolean(connection);
  const list = providers.data ?? [];
  const [providerId, setProviderId] = useState(connection?.provider ?? "");
  const provider = list.find((p) => p.id === providerId) ?? null;
  const [label, setLabel] = useState(connection?.label ?? "");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(connection?.base_url ?? "");
  const [model, setModel] = useState(connection?.default_model ?? "");
  const [limit, setLimit] = useState(connection?.monthly_token_limit ? String(connection.monthly_token_limit) : "");
  const [submitted, setSubmitted] = useState(false);
  const liveModels = useAiModels(editing ? connection!.id : null);
  const models = (editing && liveModels.data) || provider?.suggested_models || [];
  const name = providerId ? shortProviderName(providerId, list) : providerName(null, list);
  const needsBase = Boolean(provider?.needs_base_url);
  // The base URL is asked for only where the provider needs one; an existing override stays editable.
  const showBase = needsBase || Boolean(connection?.base_url);

  const parsedLimit = parseTokenLimit(limit);
  const errors = {
    provider: !providerId ? "Pick a provider." : null,
    label: !label.trim() ? "Give it a name you will recognise." : null,
    key: !editing && !key.trim() ? "Paste the API key." : null,
    base: showBase ? baseUrlError(baseUrl, needsBase) : null,
    model: !model.trim() ? "Pick or type a model." : null,
    limit: Number.isNaN(parsedLimit) ? "A whole number of tokens, or leave it empty for no limit." : null,
  };
  const valid = Object.values(errors).every((e) => !e);
  const show = (e: string | null) => (submitted ? e : null);

  const save = useMutation({
    mutationFn: async () => {
      if (connection) {
        const patch: UpdateConnectionBody = {};
        if (label.trim() !== connection.label) patch.label = label.trim();
        if (model.trim() !== connection.default_model) patch.default_model = model.trim();
        if (showBase && (baseUrl.trim() || null) !== (connection.base_url ?? null)) patch.base_url = baseUrl.trim() || null;
        if ((parsedLimit ?? null) !== (connection.monthly_token_limit ?? null)) patch.monthly_token_limit = parsedLimit;
        return api.agents.updateConnection(connection.id, patch);
      }
      const body: CreateConnectionBody = { provider: providerId, label: label.trim(), api_key: key.trim(), default_model: model.trim(), monthly_token_limit: parsedLimit };
      if (showBase && baseUrl.trim()) body.base_url = baseUrl.trim();
      return api.agents.createConnection(body);
    },
    onSuccess: (c) => {
      setKey("");
      refresh();
      if (editing) toast.success(`${c.label} saved.`);
      else reportVerdict(c, list, `${c.label} added`);
      onDone();
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${connection!.label}` : "Add AI connection"}</DialogTitle>
        <DialogDescription>
          {editing ? "Change the name, default model or monthly limit. To change the key, use Rotate key." : "Connect your own AI provider account. Payminto checks the key with the provider before saving."}
        </DialogDescription>
      </DialogHeader>
      <form
        id="aic-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (valid && !save.isPending) save.mutate();
        }}
      >
        <FormRow id="aic-provider" label="Provider" error={show(errors.provider)} hint={needsBase ? "Any endpoint that speaks the OpenAI API: OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, Ollama, vLLM, LM Studio or your own." : (provider?.note ?? undefined)}>
          <Select
            value={providerId}
            disabled={editing}
            onValueChange={(v) => {
              setProviderId(v);
              const p = list.find((x) => x.id === v);
              setModel(p?.suggested_models[0] ?? "");
              if (!label.trim() || list.some((x) => label === `Team ${shortProviderName(x.id, list)}` || label === `Team ${providerName(x.id, list)}`)) setLabel(`Team ${shortProviderName(v, list)}`);
            }}
          >
            <SelectTrigger id="aic-provider" className="w-full" aria-invalid={Boolean(show(errors.provider))}>
              <SelectValue placeholder={providers.isPending ? "Loading providers..." : "Choose a provider"} />
            </SelectTrigger>
            <SelectContent>
              {list.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {providerName(p.id, list)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
        <FormRow id="aic-label" label="Name" error={show(errors.label)} hint="Shown to your team, e.g. Team OpenAI.">
          <Input id="aic-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </FormRow>
        {!editing && <KeyField id="aic-key" value={key} onChange={setKey} error={show(errors.key)} provider={providerId ? name : "AI provider"} />}
        {showBase && (
          <FormRow id="aic-base" label="Base URL" optional={!needsBase} error={show(errors.base)} hint={needsBase ? "The provider's API address, e.g. https://openrouter.ai/api/v1." : "Only to point at a different endpoint for this provider."}>
            <Input id="aic-base" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={provider?.default_base_url ?? "https://"} className="hash" />
          </FormRow>
        )}
        <FormRow id="aic-model" label="Default model" error={show(errors.model)} hint={editing && liveModels.isError ? "The provider's model list could not be read; type the model id." : undefined}>
          <Input id="aic-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider?.suggested_models[0] ?? "Model id"} className="hash" spellCheck={false} autoComplete="off" />
          <ModelSuggestions models={models} value={model} onPick={setModel} loading={editing && liveModels.isPending} />
        </FormRow>
        <FormRow id="aic-limit" label="Monthly token limit" optional error={show(errors.limit)} hint="Runs stop starting once this month's tokens reach it. Leave empty for no limit.">
          <Input id="aic-limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" className="num" />
        </FormRow>
        {save.isError && (
          <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
            {save.error.message}
          </p>
        )}
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" form="aic-form" disabled={save.isPending || (submitted && !valid)}>
          {save.isPending ? (editing ? "Saving..." : "Checking key...") : editing ? "Save" : "Add connection"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rotate key
// ---------------------------------------------------------------------------

export function RotateKeyDialog({ connection, onOpenChange }: { connection: AiConnection | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(connection)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[28rem]">{connection && <RotateForm connection={connection} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function RotateForm({ connection, onDone }: { connection: AiConnection; onDone: () => void }) {
  const api = useApi();
  const providers = useAiProviders();
  const refresh = useRefresh();
  const [key, setKey] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const name = shortProviderName(connection.provider, providers.data);
  const error = !key.trim() ? "Paste the new API key." : null;
  const rotate = useMutation({
    mutationFn: () => api.agents.updateConnection(connection.id, { api_key: key.trim() }),
    onSuccess: (c) => {
      setKey("");
      refresh();
      reportVerdict(c, providers.data, "Key replaced");
      onDone();
    },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rotate key for {connection.label}</DialogTitle>
        <DialogDescription>
          The new key replaces the one ending {connection.key_hint ?? "in ****"} at once. Runs already working finish on the old key. Revoke the old key with {name} afterwards.
        </DialogDescription>
      </DialogHeader>
      <form
        id="aic-rotate"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (!error && !rotate.isPending) rotate.mutate();
        }}
      >
        <KeyField id="aic-new-key" value={key} onChange={setKey} error={submitted ? error : null} provider={name} />
        {rotate.isError && (
          <p role="alert" className="mt-3 rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
            {rotate.error.message}
          </p>
        )}
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" form="aic-rotate" disabled={rotate.isPending || (submitted && Boolean(error))}>
          {rotate.isPending ? "Checking key..." : "Replace key"}
        </Button>
      </DialogFooter>
    </>
  );
}
