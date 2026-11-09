"use client";

import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Bot, Download, KeyRound, ScrollText, Server, UserRound } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import type { AuditEvent, AuditQuery } from "@/lib/account";
import { formatDateTime } from "@/lib/format";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Panel } from "@/components/app/primitives";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { TimeAgo } from "@/components/app/time-ago";
import { ListHead } from "@/components/gateway/kit";
import { Dash, NoAccess } from "@/components/account/parts";

/** Action groups for the filter (PRODUCT.md section 10.10); a value ending in "." is a prefix. */
const ACTIONS: { value: string; label: string }[] = [
  { value: "auth.", label: "Sign-ins and passwords" },
  { value: "invite.", label: "Invites" },
  { value: "member.", label: "Team changes" },
  { value: "signup.", label: "Sign-ups" },
  { value: "business.", label: "Businesses" },
  { value: "payout.changed", label: "Payout wallet changes" },
  { value: "pricing.changed", label: "Pricing changes" },
  { value: "platform.", label: "Platform settings" },
  { value: "api_key.", label: "API keys" },
  { value: "webhook.", label: "Webhooks" },
  { value: "refund.", label: "Refunds" },
  { value: "settlement.run", label: "Settlements run" },
  { value: "recovery_key.used", label: "Recovery key used" },
  { value: "outbox.viewed", label: "Email outbox views" },
];

const ACTOR_ICON = { user: UserRound, api_key: Bot, recovery_key: KeyRound, system: Server } as const;
const COLS = "md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_8rem_8rem]";

function actorLabel(e: AuditEvent): string {
  if (e.actorType === "system") return "Payminto";
  if (e.actorType === "recovery_key") return "Recovery key";
  if (e.actorType === "api_key") return e.actorName ?? `API key ${e.actorId ?? ""}`.trim();
  return e.actorName ?? e.actorEmail ?? "Someone";
}

/** A plain sentence for rows the server sent without one. */
function sentence(e: AuditEvent): string {
  if (e.summary) return e.summary;
  return `${actorLabel(e)}: ${e.action.replace(/[._]/g, " ")}${e.target ? ` on ${e.target}` : ""}`;
}

function csvCell(v: string | null): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: AuditEvent[]): string {
  const head = ["time", "actor_type", "actor", "action", "summary", "target", "business", "ip"];
  const body = rows.map((e) => [e.at, e.actorType, actorLabel(e), e.action, sentence(e), e.target, e.merchantId, e.ip].map(csvCell).join(","));
  return [head.join(","), ...body].join("\n");
}

export default function ActivityPage() {
  const access = useAccess();
  const { account } = useSession();
  const allowed = access.can("audit.read");
  const merchantId = access.view?.kind === "business" ? access.view.merchantId : undefined;
  const [actor, setActor] = useState("all");
  const [action, setAction] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const query: AuditQuery = {
    merchant_id: merchantId,
    actor_id: actor === "all" ? undefined : actor,
    action: action === "all" ? undefined : action,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  };
  const q = useInfiniteQuery({
    queryKey: accountKeys.audit(query),
    queryFn: ({ pageParam }) => account.audit({ ...query, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
    placeholderData: (prev) => prev,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  // People seen in the loaded rows, kept while a person filter is on so the select does not empty itself.
  const [people, setPeople] = useState<Map<string, string>>(new Map());
  const known = useMemo(() => {
    const m = new Map(people);
    for (const e of rows) if (e.actorId && e.actorType === "user") m.set(e.actorId, actorLabel(e));
    return m;
  }, [rows, people]);
  if (!allowed) return <NoAccess title="Activity log" />;
  const csvUrl = account.auditCsvUrl(query);
  const filtered = actor !== "all" || action !== "all" || from || to;

  const downloadLocal = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payminto-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Activity log"
        description={merchantId ? "Who changed what in this business, and when. Entries can never be edited or removed." : "Who changed what on this server, and when. Entries can never be edited or removed."}
        actions={
          csvUrl ? (
            <Button variant="outline" asChild>
              <a href={csvUrl} download>
                <Download /> Export CSV
              </a>
            </Button>
          ) : (
            <Button variant="outline" onClick={downloadLocal} disabled={rows.length === 0}>
              <Download /> Export CSV
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Person</span>
          <Select
            value={actor}
            onValueChange={(v) => {
              setPeople(known);
              setActor(v);
            }}
          >
            <SelectTrigger className="w-48" aria-label="Filter by person">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              {[...known.entries()].map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Action</span>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger className="w-56" aria-label="Filter by action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every action</SelectItem>
              {ACTIONS.map((a) => (
                <SelectItem key={a.value} value={a.value}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">From</span>
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">To</span>
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </label>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setActor("all");
              setAction("all");
              setFrom("");
              setTo("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <Panel bodyClassName="p-0 sm:p-0">
        <ListHead cols={COLS}>
          <span>What happened</span>
          <span>Who</span>
          <span>When</span>
          <span>IP</span>
        </ListHead>
        {q.isPending ? (
          <RowsSkeleton className="px-5" rows={6} />
        ) : q.isError ? (
          <ErrorState className="m-4" error={q.error} onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ScrollText className="size-4" />} title={filtered ? "Nothing matches these filters" : "No activity yet"}>
            {filtered ? "Try a wider date range or another person." : "Sign-ins, team changes, payout wallet changes and refunds appear here."}
          </EmptyState>
        ) : (
          <ul className="stagger divide-y">
            {rows.map((e) => {
              const Icon = ACTOR_ICON[e.actorType];
              return (
                <li key={e.id} className={`grid grid-cols-1 gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-muted/40 sm:px-5 ${COLS}`}>
                  <span className="min-w-0">
                    <span className="block">{sentence(e)}</span>
                    <span className="hash block truncate text-[0.6875rem] text-subtle">{e.action}</span>
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{actorLabel(e)}</span>
                  </span>
                  <span className="text-xs text-muted-foreground" title={formatDateTime(e.at)}>
                    <TimeAgo iso={e.at} />
                  </span>
                  <span className="hash text-xs text-muted-foreground">{e.ip ?? <Dash />}</span>
                </li>
              );
            })}
          </ul>
        )}
        {q.hasNextPage && (
          <div className="border-t p-3 text-center">
            <Button variant="ghost" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? "Loading" : "Load more"}
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}
