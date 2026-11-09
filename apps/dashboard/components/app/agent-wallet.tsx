"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Loader2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { createPublicClient, createWalletClient, custom, defineChain, erc20Abi, http, isAddressEqual, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useApi } from "@/lib/session";
import { MOCK_MODE } from "@/lib/config";
import { chainIdOf, qk, useInfo } from "@/lib/queries";
import { hasInjectedWallet } from "@/lib/sign";
import type { MandateDetail } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field, Fields, Money, Panel } from "./primitives";

/** What the hub may still pull from the agent under this mandate: total cap minus what already settled. */
/** Wallets that approve type(uint256).max (or close to it) are shown as Unlimited instead of a 78-digit number. */
export function isUnlimited(allowance: bigint): boolean {
  return allowance >= 2n ** 255n;
}

export function allowanceNeeded(m: Pick<MandateDetail, "mandate" | "spend">): bigint {
  const need = BigInt(m.mandate.totalCap) - BigInt(m.spend.settled);
  return need > 0n ? need : 0n;
}

export function AgentWallet({ m }: { m: MandateDetail }) {
  const api = useApi();
  const info = useInfo();
  const qc = useQueryClient();
  const chainId = chainIdOf(info.data);
  const local = chainId === 31337;
  const [mode, setMode] = useState<"wallet" | "dev">(hasInjectedWallet() || !local ? "wallet" : "dev");
  const [devKey, setDevKey] = useState("");
  const [rpc, setRpc] = useState("http://127.0.0.1:8545");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const need = allowanceNeeded(m);
  const allowance = m.agentAllowance == null ? null : BigInt(m.agentAllowance);
  const balance = m.agentBalance == null ? null : BigInt(m.agentBalance);
  const short = allowance !== null && allowance < need;
  const active = m.status === "open" || m.status === "pending";
  const hub = info.data?.hub as Address | undefined;
  const token = m.mandate.token as Address;
  const agent = m.mandate.agent as Address;

  async function approve() {
    if (!hub) return;
    setBusy(true);
    setError(null);
    try {
      if (MOCK_MODE && api.mockApprove) {
        await api.mockApprove(m.id, need.toString());
      } else if (mode === "dev") {
        if (!local) throw new Error("Development keys are only accepted on the local test network (chain 31337).");
        const pk = (devKey.startsWith("0x") ? devKey : `0x${devKey}`) as Hex;
        if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("A private key is 32 bytes of hex.");
        const account = privateKeyToAccount(pk);
        if (!isAddressEqual(account.address, agent)) throw new Error("That key is not the agent wallet of this budget.");
        const chain = defineChain({ id: 31337, name: "Local test network", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
        const wallet = createWalletClient({ account, chain, transport: http(rpc) });
        const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [hub, need] });
        await createPublicClient({ chain, transport: http(rpc) }).waitForTransactionReceipt({ hash });
      } else {
        const provider = window.ethereum;
        if (!provider) throw new Error("No browser wallet found.");
        const wallet = createWalletClient({ transport: custom(provider) });
        const [from] = await wallet.requestAddresses();
        if (!from || !isAddressEqual(from, agent)) throw new Error("Switch the wallet to the agent account of this budget; only it can approve its own tokens.");
        if ((await wallet.getChainId()) !== chainId) throw new Error(`Switch the wallet to chain ${chainId}.`);
        await wallet.writeContract({ account: from, chain: null, address: token, abi: erc20Abi, functionName: "approve", args: [hub, need] });
      }
      toast.success("Approved for settlements", { description: "Your server picks up the new approval on its next balance check." });
      void qc.invalidateQueries({ queryKey: qk.mandate(m.id) });
      void qc.invalidateQueries({ queryKey: qk.mandates });
    } catch (e) {
      const msg = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
      setError(/rejected|denied/i.test(msg) ? "The approval was rejected in the wallet." : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Agent wallet" description="The agent pays from its own wallet when a settlement runs">
      <Fields>
        <Field label="Token balance">{balance === null ? <span className="text-muted-foreground">Not read yet</span> : <Money atomic={balance} />}</Field>
        <Field label="Approved for settlements" hint="How much the settlement contract may move from the agent wallet (an ERC-20 allowance to the hub).">
          {allowance === null ? (
            <span className="text-muted-foreground">Not read yet</span>
          ) : (
            isUnlimited(allowance) ? (
              <span className="text-warning" title="The agent approved the maximum uint256 amount. Approving exactly the budget total is safer.">
                Unlimited
              </span>
            ) : (
              <Money atomic={allowance} className={short ? "text-warning" : undefined} />
            )
          )}
        </Field>
        <Field label="Needed">
          <Money atomic={need} /> <span className="text-xs text-muted-foreground">cap not yet settled</span>
        </Field>
      </Fields>

      {active && !short && allowance !== null && (
        <p className="mt-4 flex items-start gap-2 text-[0.8125rem] text-muted-foreground">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" /> The allowance covers everything this mandate can still spend.
        </p>
      )}

      {active && short && (
        <div className="mt-4 space-y-3 border-t pt-4">
          <p className="text-[0.8125rem] text-muted-foreground">
            The allowance is below what this mandate can still spend, so a batch could drop this agent&apos;s calls. Approving lets ClearingHub move net amounts
            directly from the agent to the providers at settlement. The hub never holds funds; it only calls transferFrom wallet to wallet.
          </p>
          {!MOCK_MODE && local && (
            <div className="inline-flex rounded-md border p-0.5 text-sm" role="radiogroup" aria-label="Sign with">
              {(["wallet", "dev"] as const).map((v) => (
                <button
                  key={v}
                  role="radio"
                  aria-checked={mode === v}
                  onClick={() => setMode(v)}
                  disabled={v === "wallet" && !hasInjectedWallet()}
                  className={`flex h-7 items-center gap-1.5 rounded px-2.5 disabled:opacity-50 ${mode === v ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {v === "wallet" ? <Wallet className="size-3.5" /> : <KeyRound className="size-3.5" />}
                  {v === "wallet" ? "Browser wallet" : "Development key"}
                </button>
              ))}
            </div>
          )}
          {!MOCK_MODE && mode === "dev" && local && (
            <div className="grid gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="agent-key">Agent private key</Label>
                <Input id="agent-key" type="password" className="hash" value={devKey} onChange={(e) => setDevKey(e.target.value)} autoComplete="off" spellCheck={false} />
                <p className="text-xs text-muted-foreground">Local test network only. The key stays in this tab.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="agent-rpc">Local network RPC</Label>
                <Input id="agent-rpc" className="hash" value={rpc} onChange={(e) => setRpc(e.target.value)} spellCheck={false} />
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">
              {error}
            </p>
          )}
          <Button
            onClick={() => void approve()}
            disabled={busy || !hub || (!MOCK_MODE && mode === "wallet" && !hasInjectedWallet())}
            className="w-full"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Wallet />}
            Approve <Money atomic={need} unitClassName="text-primary-foreground/80" />
          </Button>
          {!MOCK_MODE && mode === "wallet" && !hasInjectedWallet() && (
            <p className="text-xs text-muted-foreground">Open this page in a browser with the agent&apos;s wallet to approve.</p>
          )}
        </div>
      )}
    </Panel>
  );
}
