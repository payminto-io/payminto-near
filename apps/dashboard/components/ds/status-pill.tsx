import { cn } from "@/lib/utils";
import { SELLER_SETTLED_LABEL } from "@/lib/seller-settlement";

export type CallState = "settled" | "waiting" | "refused";

const TONE: Record<CallState, string> = {
  settled: "bg-positive-soft text-positive",
  waiting: "bg-warning-soft text-warning",
  refused: "bg-negative-soft text-negative",
};

const WORD: Record<CallState, string> = { settled: "Settled", waiting: "Waiting", refused: "Refused" };

/**
 * Whether a Call or transfer is settled, waiting or refused, and nothing else. The word always shows, so status never
 * rests on colour alone. `label` may name the state more precisely ("In next settlement") but never another state.
 * `settledBy` says how a settled Call was settled: one its seller settled on the hub reads "Settled by the seller on
 * the hub", because it is in no settlement batch and has no Merkle proof.
 */
export function StatusPill({ status, label, settledBy, className }: { status: CallState; label?: string; settledBy?: "batch" | "seller" | null; className?: string }) {
  const word = label ?? (status === "settled" && settledBy === "seller" ? SELLER_SETTLED_LABEL : WORD[status]);
  return (
    <span className={cn("inline-flex h-[1.375rem] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap", TONE[status], className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {word}
    </span>
  );
}

/** The node's call status in the three words of the system. */
export function callState(status: string): CallState {
  return status === "settled" ? "settled" : "waiting";
}
