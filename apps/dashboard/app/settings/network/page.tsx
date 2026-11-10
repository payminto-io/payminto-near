"use client";

import { RequirePermission } from "@/components/app/states";
import { MOCK_MODE } from "@/lib/config";
import { SERVER_URL } from "@/lib/api";
import { useLive } from "@/lib/live";
import { useHealth, useInfo } from "@/lib/queries";
import { formatInt } from "@/lib/format";
import { useNetworkWords } from "@/lib/use-network-words";
import { Address, Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { BlockSkeleton, ErrorState } from "@/components/app/states";
import { OperatorWarnings } from "@/components/app/operator-warnings";
import { nearText } from "@/lib/hub-readiness";
import { useHubReadiness } from "@/lib/use-hub-readiness";

/**
 * The server's standing on the hub, read from the hub by this browser: whether its receipt key is registered, which a
 * seller needs to settle a voucher itself, and the storage balance it prepaid for settlement batches.
 */
function HubStandingFields({ nodeKey }: { nodeKey: string | undefined }) {
  const r = useHubReadiness();
  if (r.state === "off") return null;
  const waiting = r.state === "reading" ? <Chip tone="neutral">Checking</Chip> : <span className="text-muted-foreground">Could not be read. {r.error}</span>;
  const s = r.standing;
  return (
    <>
      {nodeKey && (
        <Field label="Key on the hub" hint="A seller can settle a voucher itself only with an acceptance signed by a receipt key this server's account registered on the hub.">
          {s ? s.receiptKeys.includes(nodeKey) ? <Chip tone="positive">Registered</Chip> : <Chip tone="warning">Not registered</Chip> : waiting}
        </Field>
      )}
      <Field label="Prepaid storage" hint="Settlement batches write storage on the hub, charged to a balance this server's account prepays. The hub refuses a batch the balance cannot pay for.">
        {s ? (
          <span className="flex flex-col gap-0.5">
            <span className="num">{nearText(s.storageYocto)}</span>
            <span className={s.storageYocto < r.minStorageYocto ? "text-xs text-warning" : "text-xs text-muted-foreground"}>
              {s.storageYocto < r.minStorageYocto ? `Below the ${nearText(r.minStorageYocto)} that 100 batch records cost` : `100 batch records cost ${nearText(r.minStorageYocto)}`}
            </span>
          </span>
        ) : (
          waiting
        )}
      </Field>
    </>
  );
}

function NetworkSettingsPagePage() {
  const words = useNetworkWords();
  const info = useInfo();
  const health = useHealth();
  const live = useLive();

  if (info.isError) {
    return (
      <>
        <PageHeader title="Network" />
        <ErrorState error={info.error} onRetry={() => void info.refetch()} />
      </>
    );
  }
  const d = info.data;

  return (
    <>
      <PageHeader title="Network" description="What your Payminto server is connected to. These values come from the server's environment; change them there and restart it." />
      <OperatorWarnings className="mb-5" />
      {!d ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <BlockSkeleton className="h-64" />
          <BlockSkeleton className="h-64" />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Payminto server">
            <Fields>
              <Field label="Address"><span className="hash break-all">{MOCK_MODE ? "Demo data (in this browser)" : SERVER_URL}</span></Field>
              <Field label="Version"><span className="hash">{d.version}</span></Field>
              <Field label="Health">
                {health.data ? <Chip tone={health.data.ok ? "positive" : "negative"}>{health.data.ok ? "Healthy" : "Degraded"}</Chip> : health.isError ? <Chip tone="negative">Unreachable</Chip> : <Chip tone="neutral">Checking</Chip>}
              </Field>
              <Field label="Live updates">
                <Chip tone={live.status === "live" ? "positive" : live.status === "connecting" ? "warning" : "negative"}>
                  {live.status === "live" ? "Connected" : live.status === "connecting" ? (live.wasLive ? "Reconnecting" : "Connecting") : "Offline"}
                </Chip>
              </Field>
              <Field label="Automatic settlement">
                {d.settleIntervalSec ? `Every ${formatInt(d.settleIntervalSec)} s` : "Manual, from Next settlement"}
              </Field>
            </Fields>
          </Panel>
          <Panel title="Network">
            <Fields>
              <Field label="Chain">
                {d.network.name} <span className="text-muted-foreground">· {d.network.id}</span>
              </Field>
              <Field label="Explorer">
                {d.explorer ? (
                  <a href={d.explorer} target="_blank" rel="noreferrer" className="hash break-all text-primary hover:underline">
                    {d.explorer.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="text-muted-foreground">None for a local chain</span>
                )}
              </Field>
              <Field label="Settlement contract" hint="The contract that escrows funds and pays many Calls in one transaction."><Address address={d.hub} showName={false} /></Field>
              <Field label="Token">
                <span className="flex flex-wrap items-center gap-2">
                  {d.token.symbol} <span className="text-muted-foreground">{d.token.decimals} decimals</span>
                  <Address address={d.token.address} showName={false} />
                </span>
              </Field>
            </Fields>
          </Panel>
          <Panel title="Server wallet" description={`Signs Call receipts and sends settlements. ${words.escrowFull}`}>
            <Fields>
              <Field label="Address"><Address address={d.operator} showName={false} /></Field>
              {d.nodeKey && <Field label="Receipt key"><span className="hash break-all">{d.nodeKey}</span></Field>}
              <HubStandingFields nodeKey={d.nodeKey} />
            </Fields>
          </Panel>
        </div>
      )}
    </>
  );
}

export default function NetworkSettingsPage() {
  return (
    <RequirePermission permission={"platform.read"}>
      <NetworkSettingsPagePage />
    </RequirePermission>
  );
}
