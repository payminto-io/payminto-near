"use client";

import type { ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { useToken } from "@/lib/queries";
import { formatDateTime, formatToken } from "@/lib/format";
import { sellerSettledChecks, sellerSettledVerdict } from "@/lib/seller-settlement";
import type { HubPosition } from "@/lib/use-hub-position";
import type { ReceiptProof } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { CopyButton, Field, Fields, Money, Panel } from "@/components/app/primitives";
import { AccountId } from "@/components/ds/account-id";
import { ProofPanel } from "@/components/ds/proof-panel";

/** An id a person must check: every character shown, wrapped, with copy. */
export function WrapId({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex min-w-0 items-start gap-1">
      <span className="min-w-0 font-mono text-xs leading-4 [overflow-wrap:anywhere]">{value}</span>
      <CopyButton value={value} label={label} className="-mt-1" />
    </span>
  );
}

const quiet = (t: string): ReactNode => <span className="text-muted-foreground">{t}</span>;

/**
 * The verdict of a Call its seller settled itself. There is no batch root, so the panel says so and shows what can be
 * checked instead: the seller settlement the server booked, and the hub's settled position as this browser read it.
 */
export function SellerSettledVerdict({ p, position }: { p: ReceiptProof; position: HubPosition }) {
  const t = useToken();
  const { read, source, hub } = position;
  const checks = sellerSettledChecks(p, read, (a) => formatToken(a, t.symbol, t.decimals));
  const v = sellerSettledVerdict(checks, read);
  const s = p.sellerSettlement ?? null;
  return (
    <ProofPanel
      verdict={v.verdict}
      title={v.title}
      body={v.body}
      action={
        read.state === "error" ? (
          <Button variant="outline" size="sm" onClick={position.retry} className="h-11 sm:h-8">
            <RotateCw aria-hidden /> Read NEAR again
          </Button>
        ) : null
      }
      fields={[
        { label: "Call id", value: <WrapId value={p.receipt.callId} label="Call id" /> },
        { label: "Seller settlement", value: s ? <WrapId value={s.id} label="seller settlement id" /> : quiet("Not reported") },
        {
          label: "Read from",
          value: source ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-xs [overflow-wrap:anywhere]">{source.reader.rpcUrl}</span>
              {source.demo && <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">Demo, no network</span>}
            </span>
          ) : (
            quiet("No RPC configured")
          ),
        },
        { label: "Hub", value: hub ? <AccountId value={hub} mode="wrap" /> : quiet("Loading") },
        { label: "Payee", value: <AccountId value={p.receipt.payee} mode="wrap" /> },
        {
          label: "Settled on NEAR",
          value:
            read.state === "done" ? (
              <span className="flex flex-col gap-0.5">
                <Money atomic={read.settled} />
                <span className="text-[0.6875rem] text-muted-foreground">To this Payee under this Budget, final block {read.blockHeight.toLocaleString("en-US")}</span>
              </span>
            ) : read.state === "reading" ? (
              quiet("Reading...")
            ) : (
              quiet("Not read")
            ),
        },
        { label: "Running total", value: <Money atomic={p.receipt.cumulative} /> },
      ]}
      checks={checks.map((c) => ({ key: c.key, label: c.label, state: c.state, detail: c.detail }))}
    />
  );
}

/** Beside the verdict, where a batch-settled Call shows its Merkle path: why there is none, and what the server booked. */
export function SellerSettlementPanel({ p }: { p: ReceiptProof }) {
  const s = p.sellerSettlement ?? null;
  return (
    <Panel title="Seller settlement" description="No batch root and no Merkle path: this Call is in no settlement batch">
      <div className="flex flex-col gap-4">
        {s ? (
          <Fields>
            <Field label="Settlement id" hint="The server's id for what the seller settled itself, outside any batch.">
              <WrapId value={s.id} label="seller settlement id" />
            </Field>
            <Field label="Settled before" hint="The hub's settled position of this Budget and Payee before the seller settled.">
              <Money atomic={s.previous} />
            </Field>
            <Field label="Settled after" hint="The hub's settled position after the seller settled. It covers every Call up to this running total.">
              <Money atomic={s.cumulative} />
            </Field>
            <Field label="This Call" hint="Running total the agent signed to this Payee, including this Call.">
              <Money atomic={p.receipt.cumulative} />
            </Field>
            {s.detectedAt && (
              <Field label="Found by the server">
                <span className="font-mono text-[0.8125rem]">{formatDateTime(s.detectedAt)}</span>
              </Field>
            )}
            <Field label="Server's read" hint="What the hub's settled position was when the server read it for this page.">
              {s.covered === true ? (
                <span className="flex flex-wrap items-baseline gap-x-2">
                  {s.hubSettled != null && <Money atomic={s.hubSettled} />}
                  <span className="text-positive">Covers this Call</span>
                </span>
              ) : s.covered === false ? (
                <span className="flex flex-wrap items-baseline gap-x-2">
                  {s.hubSettled != null && <Money atomic={s.hubSettled} />}
                  <span className="text-negative">Does not cover this Call</span>
                </span>
              ) : (
                quiet("The server could not read the hub")
              )}
            </Field>
          </Fields>
        ) : (
          <p className="text-sm text-muted-foreground">The server marked this Call as settled by its seller but sent no record of the settlement.</p>
        )}
        <div className="space-y-2 border-t pt-4 text-sm text-muted-foreground">
          <p>
            A Merkle path leads from a Call to the root of its settlement batch. This Call is in no batch, so there is no root to check it against. What can be checked is the hub&apos;s settled position for this Budget and
            Payee: once it is at or past this Call&apos;s running total, the hub has moved the money from the Budget&apos;s escrow to the seller&apos;s hub credit.
          </p>
          <p>
            A seller can settle its latest voucher on the hub itself (<code className="font-mono text-[0.8125rem] text-foreground">settle_own</code>), and only together with the acceptance this server signed for that exact
            Call. Vouchers carry a running total, so one seller settlement covers every earlier Call to the same Payee under the same Budget.
          </p>
        </div>
      </div>
    </Panel>
  );
}
