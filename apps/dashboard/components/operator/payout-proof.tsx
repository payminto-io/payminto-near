"use client";

import { useEffect, useState } from "react";
import { isHex, verifyMessage, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CheckCircle2, LoaderCircle, PenLine, RotateCw, Wallet, XCircle } from "lucide-react";
import { PAYOUT_PROOF_MAX_AGE_SECONDS } from "@payminto/protocol";
import { useApi } from "@/lib/session";
import { useInfo } from "@/lib/queries";
import { checksum } from "@/lib/gateway";
import { shortAddress } from "@/lib/format";
import { injected, signPersonalMessage, walletErrorMessage } from "@/lib/wallet";
import { payoutChangeMessage } from "@/lib/operator-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormRow } from "@/components/gateway/kit";
import { CopyButton } from "@/components/app/primitives";
import { Notice } from "@/components/checkout/parts";
import { useNow } from "@/components/app/time-ago";

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export type PayoutProof = { payout: Address; timestamp: number; signature: Hex };

/**
 * The payout wallet proves control by signing the section 14.3 message, so nobody can point a merchant's money at a
 * wallet they do not hold. With a browser wallet the connected account must be the payout being registered; without
 * one (or for a hardware or cold wallet) the message is signed elsewhere and the signature pasted, then checked here
 * against the payout before Continue unlocks.
 */
export function PayoutProofField({ subject, value, onChange }: { subject: string; value: PayoutProof | null; onChange: (p: PayoutProof | null) => void }) {
  const api = useApi();
  const [address, setAddress] = useState(value?.payout ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState("");
  // The signed text must not change while someone copies it into another wallet, so its timestamp is fixed until refreshed.
  const [stamp, setStamp] = useState(() => value?.timestamp ?? unixNow());
  const target = checksum(address);
  const mockNoWallet = api.mock && hasWallet === false;
  const now = useNow();
  // Proofs are bound to this node's chain and hub (GATEWAY.md section 14.3).
  const { data: info } = useInfo();
  const chainId = info ? (info.chainId ?? info.network.chainId) : 0;
  const scope = info && chainId ? { chainId, hub: info.hub as Address } : null;
  const message = payoutChangeMessage(subject || "{merchant}", target ?? "{payout}", value?.timestamp ?? stamp, scope);
  const ageLeft = PAYOUT_PROOF_MAX_AGE_SECONDS - (Math.floor(now / 1000) - (value?.timestamp ?? stamp));
  const stale = ageLeft <= 0;
  const manual = !mockNoWallet && (pasteMode || hasWallet === false);

  // window.ethereum is only readable after hydration.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only capability check
  useEffect(() => setHasWallet(Boolean(injected())), []);

  async function sign() {
    setError(null);
    setBusy(true);
    try {
      if (!scope) throw new Error("Your server's chain and hub are still loading. Try again in a moment.");
      const timestamp = unixNow();
      setStamp(timestamp);
      if (mockNoWallet) {
        // Mock mode without a wallet: a throwaway key stands in for the payout wallet and becomes the payout.
        const acct = privateKeyToAccount(generatePrivateKey());
        const signature = await acct.signMessage({ message: payoutChangeMessage(subject, acct.address, timestamp, scope) });
        setAddress(acct.address);
        onChange({ payout: acct.address, timestamp, signature });
        return;
      }
      if (!target) throw new Error("Enter the payout address first.");
      const { address: signer, signature } = await signPersonalMessage(payoutChangeMessage(subject, target, timestamp, scope));
      if (signer.toLowerCase() !== target.toLowerCase()) throw new Error(`The connected wallet is ${shortAddress(signer)}. Connect ${shortAddress(target)} to sign for it.`);
      onChange({ payout: target, timestamp, signature });
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function checkPasted(raw: string) {
    setPasted(raw);
    setError(null);
    const sig = raw.trim();
    if (!sig) return;
    if (!target) return setError("Enter the payout address first.");
    if (!isHex(sig) || sig.length !== 132) return setError("A signature is 0x followed by 130 hex characters.");
    if (stale) return setError("This message has expired. Refresh it, then sign the new text.");
    if (!scope) return setError("Your server's chain and hub are still loading. Try again in a moment.");
    const valid = await verifyMessage({ address: target, message: payoutChangeMessage(subject, target, stamp, scope), signature: sig }).catch(() => false);
    if (!valid) return setError(`This signature is not from ${shortAddress(target)} over the message above. Sign the exact text, with the payout wallet.`);
    onChange({ payout: target, timestamp: stamp, signature: sig });
  }

  function refresh() {
    setStamp(unixNow());
    setPasted("");
    setError(null);
    onChange(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <FormRow id="payout" label="Payout wallet" hint="Every payment for this business lands here, minus fees, in the same transaction." error={address && !target ? "Enter a valid 0x address." : null}>
        <Input
          id="payout"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            // A fresh timestamp once the address is complete, so the full validity window is left for signing.
            if (checksum(e.target.value) && !checksum(address)) setStamp(unixNow());
            setPasted("");
            setError(null);
            onChange(null);
          }}
          placeholder="0x…"
          className="hash text-[0.8125rem]"
          spellCheck={false}
          autoComplete="off"
        />
      </FormRow>
      {hasWallet === false && !mockNoWallet && !value && (
        <Notice tone="neutral" icon={<Wallet />}>
          No browser wallet on this device. Sign the message below with the payout wallet wherever it lives (a hardware wallet, a mobile wallet, or <span className="hash">cast wallet sign</span>), then paste the signature.
        </Notice>
      )}
      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">Message the payout wallet signs</p>
          {manual && target && !value && <CopyButton value={message} label="message" />}
        </div>
        <p className="hash mt-1 text-[0.8125rem] [overflow-wrap:anywhere]">{message}</p>
        {manual && !value && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {stale ? (
              <span className="text-warning">This message has expired.</span>
            ) : (
              <span>
                Valid for <span className="num">{Math.floor(ageLeft / 60)}:{String(ageLeft % 60).padStart(2, "0")}</span>
              </span>
            )}
            <button type="button" onClick={refresh} className="inline-flex items-center gap-1 rounded font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2">
              <RotateCw className="size-3" aria-hidden /> New timestamp
            </button>
          </p>
        )}
      </div>
      {value ? (
        <p className="flex items-center gap-2 text-sm text-positive" role="status">
          <CheckCircle2 className="size-4" aria-hidden /> Signed by <span className="hash">{shortAddress(value.payout)}</span>
        </p>
      ) : manual ? (
        <FormRow id="payout-sig" label="Signature" hint="Paste the 0x signature of the exact message above. It is checked here before you can continue.">
          <Input id="payout-sig" value={pasted} onChange={(e) => void checkPasted(e.target.value)} placeholder="0x…" className="hash text-[0.8125rem]" spellCheck={false} autoComplete="off" disabled={!target} />
        </FormRow>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="button" variant="outline" onClick={() => void sign()} disabled={busy || hasWallet === null || (!target && !mockNoWallet)}>
            {busy ? <LoaderCircle className="animate-spin" /> : <PenLine />}
            {mockNoWallet ? "Sign with a demo payout wallet" : "Sign with the payout wallet"}
          </Button>
          {hasWallet && (
            <button type="button" onClick={() => (setPasteMode(true), refresh())} className="rounded text-sm font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2">
              Signed elsewhere? Paste a signature
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-negative">
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
    </div>
  );
}
