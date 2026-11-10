"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AccountId } from "@payminto/protocol";
import { useInfo } from "./queries";
import { parseAccountList } from "./sign";
import { PayeeGate, payeeCheckContext, readPayee, type PayeeRow } from "./payee-check";

/** How long the "Other Payee accounts" field must rest before its accounts are checked. */
export const TYPED_PAUSE_MS = 900;

export type BudgetPayees = {
  /** One row per picked Payee: ticked ones first, then typed ones, in the order given. */
  rows: readonly PayeeRow[];
  row(payee: AccountId): PayeeRow | undefined;
  /** The Payees in the Budget's terms right now. A Payee that is not confirmed is not among them. */
  added: AccountId[];
  /** Picked, and still being checked or about to be. */
  waiting: AccountId[];
  /** Checked, and waiting for the owner to confirm or remove them. */
  undecided: AccountId[];
  /** The owner's yes. `typed` is needed for a blocked Payee. Returns whether the Payee is now in the Budget. */
  confirm(payee: AccountId, typed?: string): boolean;
  recheck(payee: AccountId): void;
  /** Checks what is typed now, without waiting for the pause. Call it when the field loses focus. */
  settleTyped(): void;
};

/**
 * The Payees of a Budget being written, each checked before it is added. Ticked Payees are checked at once; typed
 * accounts when the field loses focus or after a pause, never on every key. `payer` is the owner, when known.
 */
export function useBudgetPayees(ticked: readonly AccountId[], typedText: string, payer: AccountId | null): BudgetPayees {
  const info = useInfo();
  const ctx = useMemo(() => (info.data ? payeeCheckContext(info.data) : null), [info.data]);
  const [gate] = useState(() => new PayeeGate());
  const [settledText, setSettledText] = useState(typedText);

  useEffect(() => {
    if (typedText === settledText) return;
    const t = setTimeout(() => setSettledText(typedText), TYPED_PAUSE_MS);
    return () => clearTimeout(t);
  }, [typedText, settledText]);

  useEffect(() => {
    gate.configure(ctx ? (payee) => readPayee(ctx, { payee, payer }) : null);
  }, [gate, ctx, payer]);

  const typedNow = useMemo(() => parseAccountList(typedText).valid, [typedText]);
  const typedSettled = useMemo(() => parseAccountList(settledText).valid, [settledText]);
  // A typed account is checked once the field rests, and forgotten the moment it is deleted.
  const selected = useMemo(() => [...new Set([...ticked, ...typedSettled.filter((p) => typedNow.includes(p))])], [ticked, typedSettled, typedNow]);
  const picked = useMemo(() => [...new Set([...ticked, ...typedNow])], [ticked, typedNow]);

  useEffect(() => {
    gate.sync(selected);
  }, [gate, selected]);

  const rows = useSyncExternalStore(gate.subscribe, gate.rows, gate.rows);

  return useMemo(() => {
    const byPayee = new Map(rows.map((r) => [r.payee, r]));
    const live = (p: AccountId) => (picked.includes(p) ? byPayee.get(p) : undefined);
    return {
      rows: rows.filter((r) => picked.includes(r.payee)),
      row: live,
      added: picked.filter((p) => live(p)?.state === "added"),
      waiting: picked.filter((p) => !live(p) || live(p)!.state === "checking"),
      undecided: picked.filter((p) => {
        const s = live(p)?.state;
        return s === "needs_confirm" || s === "needs_typed_id" || s === "unavailable";
      }),
      confirm: (payee, typed) => gate.confirm(payee, typed),
      recheck: (payee) => gate.recheck(payee),
      settleTyped: () => setSettledText(typedText),
    };
  }, [rows, picked, gate, typedText]);
}
