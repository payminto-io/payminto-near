"use client";

/**
 * On the platform's business detail: how far the business got with setup, its latest payments, and inviting its
 * Admin. Everything is read with the business named in Merchant-Id, as a platform role may.
 */
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CreditCard, UserPlus } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import { usePayments } from "@/lib/gateway-queries";
import { useMerchantMethods } from "@/lib/operator-queries";
import { anyChainState, payoutProven } from "@/lib/setup-checklist";
import type { PayoutHistory } from "@/lib/platform-schemas";
import { formatInt, plural } from "@/lib/format";
import { accountKeys } from "@/components/app/nav-badges";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { InviteDialog } from "@/components/account/parts";
import { PaymentRow } from "@/components/gateway/payment-row";

type Row = { label: string; state: "done" | "open" | "off" | "loading" | "error"; text: string };

function StatusRow({ r }: { r: Row }) {
  return (
    <li className="flex min-h-11 items-center justify-between gap-4 py-2 text-sm">
      <span className="min-w-0">{r.label}</span>
      {r.state === "loading" ? (
        <Skeleton className="h-5 w-24" />
      ) : (
        <Chip tone={r.state === "done" ? "positive" : r.state === "open" ? "warning" : r.state === "error" ? "negative" : "neutral"}>{r.text}</Chip>
      )}
    </li>
  );
}

/** Payout proven, any chain, team size and first payment, with "Invite the business's Admin". */
export function BusinessSetupPanel({ merchant }: { merchant: PayoutHistory & { id: string; name: string } }) {
  const access = useAccess();
  const { account } = useSession();
  const [inviteOpen, setInviteOpen] = useState(false);
  const id = merchant.id;
  const methods = useMerchantMethods(id);
  const canTeam = access.can("members.read", id);
  const members = useQuery({ queryKey: accountKeys.members(id), queryFn: () => account.members(id), enabled: canTeam });
  const paid = usePayments({ merchant_id: id, status: ["paid", "overpaid"], limit: 1 });
  const any = methods.data ? anyChainState(methods.data) : null;
  const admins = (members.data ?? []).filter((m) => m.role === "admin").length;
  const team = members.data?.length ?? 0;

  const rows: Row[] = [
    payoutProven(merchant)
      ? { label: "Payout account", state: "done", text: "Proven" }
      : { label: "Payout account", state: "open", text: merchant.payout ? "Not signed" : "Not set" },
    methods.isError
      ? { label: "Accept any chain", state: "error", text: "Could not load" }
      : any === null
        ? { label: "Accept any chain", state: "loading", text: "" }
        : any === "on"
          ? { label: "Accept any chain", state: "done", text: "On" }
          : any === "off"
            ? { label: "Accept any chain", state: "open", text: "Off" }
            : { label: "Accept any chain", state: "off", text: "Not on this server" },
    !canTeam
      ? { label: "Team", state: "off", text: "-" }
      : members.isError
        ? { label: "Team", state: "error", text: "Could not load" }
        : members.isPending
          ? { label: "Team", state: "loading", text: "" }
          : { label: "Team", state: admins > 0 ? "done" : "open", text: `${formatInt(team)} ${plural(team, "person", "people")}${admins === 0 ? ", no Admin" : ""}` },
    paid.isError
      ? { label: "First payment", state: "error", text: "Could not load" }
      : paid.isPending
        ? { label: "First payment", state: "loading", text: "" }
        : paid.data.items.length > 0
          ? { label: "First payment", state: "done", text: "Paid" }
          : { label: "First payment", state: "open", text: "Not yet" },
  ];
  const done = rows.filter((r) => r.state === "done").length;
  const counted = rows.filter((r) => r.state !== "off").length;

  return (
    <Panel
      title="Setup"
      description={`${done} of ${counted} done`}
      actions={
        access.can("members.manage", id) && (
          <Button size="sm" variant={admins === 0 && members.data ? "default" : "outline"} onClick={() => setInviteOpen(true)}>
            <UserPlus /> Invite an Admin
          </Button>
        )
      }
    >
      <ul className="-my-2 divide-y">
        {rows.map((r) => (
          <StatusRow key={r.label} r={r} />
        ))}
      </ul>
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        scope={id}
        roles={["admin"]}
        title={`Invite an Admin to ${merchant.name}`}
        description="An Admin runs this business: its payout wallet, team, API keys and refunds. Without an email server the link waits in the Email outbox, and you can copy it here."
      />
    </Panel>
  );
}

/** The business's last five payments, and every payment filtered to it on Payments. */
export function RecentBusinessPayments({ merchantId }: { merchantId: string }) {
  const recent = usePayments({ merchant_id: merchantId, limit: 5 });
  return (
    <Panel
      title="Recent payments"
      bodyClassName="p-0 sm:p-0"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={`/payments?business=${encodeURIComponent(merchantId)}`}>
            All payments <ArrowRight />
          </Link>
        </Button>
      }
    >
      {recent.isPending ? (
        <RowsSkeleton className="px-5" rows={5} />
      ) : recent.isError ? (
        <ErrorState className="m-4" error={recent.error} onRetry={() => void recent.refetch()} />
      ) : recent.data.items.length === 0 ? (
        <EmptyState icon={<CreditCard className="size-4" />} title="No payments yet">
          Payments to this business show up here the moment they arrive.
        </EmptyState>
      ) : (
        <ul className="divide-y">
          {recent.data.items.map((p) => (
            <PaymentRow key={p.id} p={p} compact />
          ))}
        </ul>
      )}
    </Panel>
  );
}
