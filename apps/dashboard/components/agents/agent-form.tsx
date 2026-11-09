"use client";

/**
 * Create and edit an AI agent (docs/AGENTS.md sections 4 and 7): kind, name, connection and model, instructions and
 * limits; a paid skill adds its address, price, description and an input hint. The kind is fixed once created.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Sparkles } from "lucide-react";
import { useApi } from "@/lib/session";
import { ak, useAiConnections, useAiModels, useAiProviders, useBusinessId } from "@/lib/agents-queries";
import { CONNECTION_STATUS, KIND_HINT, KIND_LABEL, OPS_TOOLS, SLUG_PATTERN, providerName, skillUrl, slugify } from "@/lib/agents";
import { parseAmountInput, plainAmount } from "@/lib/gateway";
import { useInfo, useToken } from "@/lib/queries";
import { SERVER_URL } from "@/lib/api";
import { AGENT_LIMIT_DEFAULTS, type Agent, type AgentKind } from "@/lib/schemas";
import type { CreateAgentBody, UpdateAgentBody } from "@/lib/agents-api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState } from "@/components/app/states";
import { FormRow, Segmented, Unit } from "@/components/gateway/kit";
import { ModelSuggestions } from "@/components/agents/connection-dialogs";
import { OwnAccountNote } from "@/components/agents/parts";

type Limits = { max_turns: string; max_output_tokens: string; timeout_seconds: string };

const LIMIT_BOUNDS: Record<keyof Limits, [number, number]> = { max_turns: [1, 50], max_output_tokens: [256, 200_000], timeout_seconds: [10, 900] };

function wholeIn(raw: string, [min, max]: [number, number]): number | null {
  const t = raw.replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

export function AgentForm({ agent }: { agent?: Agent }) {
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const b = useBusinessId();
  const t = useToken();
  const info = useInfo();
  const connections = useAiConnections();
  const providers = useAiProviders();
  const editing = Boolean(agent);

  const [kind, setKind] = useState<AgentKind>(agent?.kind ?? "ops");
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [connectionId, setConnectionId] = useState(agent?.connection_id ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [tools, setTools] = useState<string[]>(agent?.tools ?? OPS_TOOLS.map((x) => x.name));
  const [slug, setSlug] = useState(agent?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(agent?.slug));
  const [price, setPrice] = useState(agent?.price ? plainAmount(agent.price, t.decimals) : "");
  const [inputHint, setInputHint] = useState(agent?.input_hint ?? "");
  const lim = agent?.limits ?? AGENT_LIMIT_DEFAULTS;
  const [limits, setLimits] = useState<Limits>({ max_turns: String(lim.max_turns), max_output_tokens: String(lim.max_output_tokens), timeout_seconds: String(lim.timeout_seconds) });
  const [advanced, setAdvanced] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const list = connections.data ?? [];
  // A new agent starts on the first working connection and its default model.
  const fallback = list.find((c) => c.status === "active") ?? list[0];
  const chosenId = connectionId || (editing ? "" : fallback?.id ?? "");
  const conn = list.find((c) => c.id === chosenId) ?? null;
  const chosenModel = model || (editing ? "" : conn?.default_model ?? "");
  const liveModels = useAiModels(conn && conn.status === "active" ? conn.id : null);
  const suggestions = liveModels.data ?? providers.data?.find((p) => p.id === conn?.provider)?.suggested_models ?? [];
  const skill = kind === "skill";
  const shownSlug = slugTouched ? slug : slugify(name);
  const priceP = skill ? parseAmountInput(price, t.decimals) : null;
  const limitValues = {
    max_turns: wholeIn(limits.max_turns, LIMIT_BOUNDS.max_turns),
    max_output_tokens: wholeIn(limits.max_output_tokens, LIMIT_BOUNDS.max_output_tokens),
    timeout_seconds: wholeIn(limits.timeout_seconds, LIMIT_BOUNDS.timeout_seconds),
  };
  const errors = {
    name: !name.trim() ? "Give the agent a name." : null,
    connection: !conn ? "Pick the AI connection it runs on." : null,
    model: !chosenModel.trim() ? "Pick or type a model." : null,
    slug: skill && !SLUG_PATTERN.test(shownSlug) ? "Lowercase letters, numbers and dashes, starting and ending with a letter or number." : null,
    price: priceP && !priceP.ok ? priceP.error : null,
    description: skill && !description.trim() ? "Buyers see this in the directory before they pay." : null,
    tools: !skill && tools.length === 0 ? "Pick at least one thing it may do." : null,
    max_turns: limitValues.max_turns === null ? `A whole number from ${LIMIT_BOUNDS.max_turns[0]} to ${LIMIT_BOUNDS.max_turns[1]}.` : null,
    max_output_tokens: limitValues.max_output_tokens === null ? `A whole number from ${LIMIT_BOUNDS.max_output_tokens[0].toLocaleString("en-US")} to ${LIMIT_BOUNDS.max_output_tokens[1].toLocaleString("en-US")}.` : null,
    timeout_seconds: limitValues.timeout_seconds === null ? `A whole number of seconds from ${LIMIT_BOUNDS.timeout_seconds[0]} to ${LIMIT_BOUNDS.timeout_seconds[1]}.` : null,
  };
  const limitError = Boolean(errors.max_turns || errors.max_output_tokens || errors.timeout_seconds);
  const valid = Object.values(errors).every((e) => !e);
  const show = (e: string | null) => (submitted ? e : null);

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        name: name.trim(),
        description: description.trim() || null,
        connection_id: conn!.id,
        model: chosenModel.trim(),
        instructions: instructions.trim() || null,
        limits: { max_turns: limitValues.max_turns!, max_output_tokens: limitValues.max_output_tokens!, timeout_seconds: limitValues.timeout_seconds! },
        ...(skill ? { slug: shownSlug, price: priceP?.ok ? priceP.atomic.toString() : undefined, input_hint: inputHint.trim() || null, tools: [] } : { tools }),
      };
      if (agent) return api.agents.updateAgent(agent.id, common satisfies UpdateAgentBody);
      return api.agents.createAgent({ kind, ...common } satisfies CreateAgentBody);
    },
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ak.agents(b) });
      qc.setQueryData(ak.agent(b, a.id), a);
      toast.success(editing ? `${a.name} saved.` : `${a.name} created.`);
      router.push(`/agents/${a.id}`);
    },
  });

  const submit = () => {
    setSubmitted(true);
    if (limitError) setAdvanced(true);
    if (valid && !save.isPending) save.mutate();
  };

  const back = agent ? { href: `/agents/${agent.id}`, label: agent.name } : { href: "/agents", label: "AI agents" };

  if (connections.isSuccess && list.length === 0) {
    return (
      <>
        <PageHeader back={back} title={editing ? `Edit ${agent!.name}` : "New AI agent"} />
        <div className="rounded-xl border bg-card">
          <EmptyState icon={<Sparkles className="size-4" />} title="Add an AI connection first" action={<Button asChild><Link href="/settings/ai">Open AI models</Link></Button>}>
            Agents run on your own AI provider account. Add a key from Anthropic, OpenAI, Google Gemini or an OpenAI-compatible provider, then come back.
          </EmptyState>
        </div>
      </>
    );
  }

  const url = skillUrl({ slug: shownSlug || "your-skill", skill_url: null }, info.data?.publicUrl ?? SERVER_URL);

  return (
    <>
      <PageHeader
        back={back}
        title={editing ? `Edit ${agent!.name}` : "New AI agent"}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={back.href}>Cancel</Link>
            </Button>
            <Button onClick={submit} disabled={save.isPending || (submitted && !valid)}>
              {editing ? "Save" : "Create agent"}
            </Button>
          </>
        }
      />
      <form
        className="grid gap-5 xl:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Agent">
            <div className="flex flex-col gap-5">
              {!editing && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Kind</span>
                  <Segmented
                    label="Kind"
                    value={kind}
                    onChange={setKind}
                    className="w-full"
                    options={[
                      { key: "ops", label: KIND_LABEL.ops },
                      { key: "skill", label: KIND_LABEL.skill },
                    ]}
                  />
                  <p className="text-xs text-muted-foreground">{KIND_HINT[kind]}</p>
                </div>
              )}
              <FormRow id="ag-name" label="Name" error={show(errors.name)} hint={skill ? "Buyers see it, e.g. Product copy writer." : "Your team sees it, e.g. Store assistant."}>
                <Input id="ag-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-invalid={Boolean(show(errors.name))} />
              </FormRow>
              <FormRow id="ag-desc" label="Description" optional={!skill} error={show(errors.description)} hint={skill ? "What a buyer gets for the price, in one or two sentences." : undefined}>
                <Textarea id="ag-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={300} />
              </FormRow>
            </div>
          </Panel>

          <Panel title="Model" description="Which of your AI connections it runs on.">
            <div className="flex flex-col gap-5">
              <FormRow id="ag-conn" label="AI connection" error={show(errors.connection)} hint={conn && conn.status !== "active" ? `${CONNECTION_STATUS[conn.status].text}` : undefined}>
                <Select
                  value={chosenId}
                  onValueChange={(v) => {
                    setConnectionId(v);
                    setModel(list.find((c) => c.id === v)?.default_model ?? "");
                  }}
                >
                  <SelectTrigger id="ag-conn" className="w-full" aria-invalid={Boolean(show(errors.connection))}>
                    <SelectValue placeholder="Choose a connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {list.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label} ({providerName(c.provider, providers.data)}){c.status !== "active" ? `, ${CONNECTION_STATUS[c.status].label.toLowerCase()}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormRow>
              <FormRow id="ag-model" label="Model" error={show(errors.model)} hint={conn ? `The connection's default is ${conn.default_model}.` : undefined}>
                <Input id="ag-model" value={chosenModel} onChange={(e) => setModel(e.target.value)} className="hash" spellCheck={false} autoComplete="off" />
                <ModelSuggestions models={suggestions} value={chosenModel} onPick={setModel} loading={liveModels.isFetching && !liveModels.data} />
              </FormRow>
              <OwnAccountNote />
            </div>
          </Panel>

          <Panel title="Instructions">
            <FormRow id="ag-instr" label="Extra instructions" optional hint="Added to Payminto's built-in instructions for this kind of agent. They never replace its safety rules.">
              <Textarea
                id="ag-instr"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                maxLength={4000}
                placeholder={skill ? "Two sentences, warm and concrete, no superlatives." : "Answer in short sentences. Never approve refunds; only request them."}
              />
            </FormRow>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {skill ? (
            <Panel title="Selling it" description="Buyers and their agents pay per call through your payment link flow, then get the answer.">
              <div className="flex flex-col gap-5">
                <FormRow id="ag-slug" label="Address" error={show(errors.slug)} hint={url ? <span className="hash break-all">{url}</span> : undefined}>
                  <Input
                    id="ag-slug"
                    value={shownSlug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setSlug(e.target.value.toLowerCase());
                    }}
                    maxLength={48}
                    className="hash"
                    spellCheck={false}
                    aria-invalid={Boolean(show(errors.slug))}
                  />
                </FormRow>
                <FormRow id="ag-price" label="Price per call" error={price || submitted ? errors.price : null} hint={`Paid in ${t.symbol} before the agent starts. Nobody pays when the agent cannot run.`}>
                  <Unit unit={t.symbol}>
                    <Input id="ag-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.25" className="num pr-16" aria-invalid={Boolean((price || submitted) && errors.price)} />
                  </Unit>
                </FormRow>
                <FormRow id="ag-hint" label="Input hint" optional hint="An example request, shown to buyers and used in the code examples.">
                  <Input id="ag-hint" value={inputHint} onChange={(e) => setInputHint(e.target.value)} maxLength={200} placeholder="Trail Flask 750: steel, keeps drinks hot 12 h" />
                </FormRow>
              </div>
            </Panel>
          ) : (
            <Panel title="What it may do" description="It works on this business's data only, and can request refunds but never approve them.">
              <fieldset className="flex flex-col gap-3">
                <legend className="sr-only">Allowed actions</legend>
                {OPS_TOOLS.map((tool) => (
                  <div key={tool.name} className="flex items-center justify-between gap-4">
                    <label htmlFor={`tool-${tool.name}`} className="text-sm">
                      {tool.label}
                    </label>
                    <Switch
                      id={`tool-${tool.name}`}
                      checked={tools.includes(tool.name)}
                      onCheckedChange={(on) => setTools((prev) => (on ? [...prev, tool.name] : prev.filter((x) => x !== tool.name)))}
                    />
                  </div>
                ))}
                {show(errors.tools) && <p className="text-xs text-negative">{errors.tools}</p>}
              </fieldset>
            </Panel>
          )}

          <Panel>
            <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn("size-4 transition-transform", advanced && "rotate-180")} aria-hidden /> Limits
            </button>
            {!advanced && (
              <p className="mt-1 text-xs text-muted-foreground">
                Up to {limits.max_turns} steps, {Number(limits.max_output_tokens.replace(/\D/g, "") || 0).toLocaleString("en-US")} output tokens and {limits.timeout_seconds} seconds per run.
              </p>
            )}
            {advanced && (
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <FormRow id="ag-turns" label="Steps" error={show(errors.max_turns)} hint="Model turns per run.">
                  <Input id="ag-turns" inputMode="numeric" value={limits.max_turns} onChange={(e) => setLimits({ ...limits, max_turns: e.target.value })} className="num" />
                </FormRow>
                <FormRow id="ag-out" label="Output tokens" error={show(errors.max_output_tokens)} hint="Per run.">
                  <Input id="ag-out" inputMode="numeric" value={limits.max_output_tokens} onChange={(e) => setLimits({ ...limits, max_output_tokens: e.target.value })} className="num" />
                </FormRow>
                <FormRow id="ag-time" label="Time limit" error={show(errors.timeout_seconds)} hint="Seconds per try.">
                  <Unit unit="s">
                    <Input id="ag-time" inputMode="numeric" value={limits.timeout_seconds} onChange={(e) => setLimits({ ...limits, timeout_seconds: e.target.value })} className="num pr-8" />
                  </Unit>
                </FormRow>
              </div>
            )}
          </Panel>

          {save.isError && (
            <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
              {save.error.message}
            </p>
          )}
        </div>
        <button type="submit" className="sr-only">
          {editing ? "Save" : "Create agent"}
        </button>
      </form>
    </>
  );
}
