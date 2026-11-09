"use client";

import { RequirePermission } from "@/components/app/states";
import { hashkeyContracts, networks, type HashKeyContracts } from "@payminto/protocol";
import { MOCK_MODE } from "@/lib/config";
import { SERVER_URL } from "@/lib/api";
import { useLive } from "@/lib/live";
import { chainIdOf, useHealth, useInfo } from "@/lib/queries";
import { formatInt, formatMoney } from "@/lib/format";
import { Address, Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { BlockSkeleton, ErrorState } from "@/components/app/states";

function NetworkSettingsPagePage() {
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
  const chainId = chainIdOf(d);
  const net = networks[chainId];
  const native = net?.chain.nativeCurrency;

  return (
    <>
      <PageHeader title="Network" description="What your Payminto server is connected to. These values come from the server's environment; change them there and restart it." />
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
              <Field label="HashKey settlement receipt" hint="HashKey's standard record that each transfer matches its settlement (HSP).">
                <span className="flex flex-col gap-0.5">
                  <span className="hash">{d.hspMode ?? health.data?.hspMode ?? "-"}</span>
                  <span className="text-xs text-muted-foreground">
                    {(d.hspMode ?? health.data?.hspMode) === "coordinator"
                      ? "Each bundled transfer is reported to HashKey's coordinator."
                      : "Your server checks each bundled transfer itself."}
                  </span>
                </span>
              </Field>
            </Fields>
          </Panel>
          <Panel title="Network">
            <Fields>
              <Field label="Chain">
                {d.network.name} <span className="text-muted-foreground">· chain {chainId}</span>
              </Field>
              <Field label="Latest block"><span className="num">{health.data?.blockNumber != null ? formatInt(health.data.blockNumber) : "-"}</span></Field>
              <Field label="Explorer">
                {d.explorer ? (
                  <a href={d.explorer} target="_blank" rel="noreferrer" className="hash break-all text-primary hover:underline">
                    {d.explorer.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="text-muted-foreground">None for a local chain</span>
                )}
              </Field>
              <Field label="Settlement contract" hint="The contract that pays many charges in one transaction (ClearingHub)."><Address address={d.hub} showName={false} /></Field>
              <Field label="Token">
                <span className="flex flex-wrap items-center gap-2">
                  {d.token.symbol} <span className="text-muted-foreground">{d.token.decimals} decimals</span>
                  <Address address={d.token.address} showName={false} />
                </span>
              </Field>
            </Fields>
          </Panel>
          <Panel title="Server wallet" description="Signs charge receipts and sends settlements. It pays the network fee only and never holds anyone's money.">
            <Fields>
              <Field label="Address"><Address address={d.operator} showName={false} /></Field>
              <Field label="Network fee balance">
                {d.operatorGasBalance != null ? (
                  <span className="num">
                    {formatMoney(d.operatorGasBalance, native?.decimals ?? 18, { maxFraction: 4 })}{" "}
                    <span className="text-muted-foreground">{native?.symbol ?? "native"}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not reported by this server</span>
                )}
              </Field>
            </Fields>
          </Panel>
          <HashKeyPanel chainId={chainId} />
        </div>
      )}
    </>
  );
}

/** Shared HashKey Chain contracts Payminto works with, so the platform owner can see what is live where. */
function HashKeyPanel({ chainId }: { chainId: number }) {
  const onHashKey = chainId === 177 || chainId === 133;
  const id = (onHashKey ? chainId : 133) as 177 | 133;
  const c: HashKeyContracts = hashkeyContracts[id];
  const rows: [string, string, string | undefined][] = [
    ["Permit2", "Signature approvals for tokens without EIP-2612", c.permit2],
    ["Multicall3", "Batched reads", c.multicall3],
    ["Safe factory", "Safe v1.4.1, for company-owned budgets", c.safe.proxyFactory],
    ["EAS", "Public records of payments", c.eas],
    ["CCIP router", "Cross-chain messaging", c.ccipRouter],
    ["APRO USDC/USD", "Price feed, 8 decimals", c.apro.usdcUsd],
    ["APRO USDT/USD", "Price feed, 8 decimals", c.apro.usdtUsd],
    ["USDT", "Bridged stablecoin", c.usdt],
  ];
  return (
    <Panel
      title="HashKey Chain contracts"
      description={
        onHashKey
          ? "Shared contracts on this network, checked live."
          : `This server runs on a local chain (${chainId}). On HashKey Chain Testnet Payminto works with these contracts.`
      }
      className="lg:col-span-2"
    >
      <Fields className="lg:grid-cols-2">
        {rows
          .filter((r): r is [string, string, string] => Boolean(r[2]))
          .map(([name, hint, address]) => (
            <Field key={name} label={name}>
              <span className="flex flex-col gap-0.5">
                <Address address={address} showName={false} explorer={onHashKey} />
                <span className="text-xs text-muted-foreground">{hint}</span>
              </span>
            </Field>
          ))}
      </Fields>
    </Panel>
  );
}

export default function NetworkSettingsPage() {
  return (
    <RequirePermission permission={"platform.read"}>
      <NetworkSettingsPagePage />
    </RequirePermission>
  );
}
