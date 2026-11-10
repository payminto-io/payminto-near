"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { AccountId as NearAccount } from "@payminto/protocol";
import { MOCK_MODE } from "@/lib/config";
import { confirmationFor, typedIdMatches, type PayeeRow } from "@/lib/payee-check";
import { parseAccountList } from "@/lib/sign";
import type { BudgetPayees } from "@/lib/use-payee-check";
import type { Provider } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { AccountId, AccountSentence, AccountText } from "@/components/ds/account-id";
import { PayeeVerdict, PayeeVerdictMark, VerdictWords, accountsNamed } from "@/components/ds/payee-verdict";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Money } from "./primitives";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A small action inside a row: 44px tall on a phone, compact from 640px. */
const ROW_BUTTON = "h-11 sm:h-8";

function Checking({ again = false }: { again?: boolean }) {
  return (
    <p role="status" className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Loader2 aria-hidden className="mt-px size-3.5 shrink-0 animate-spin" />
      <span>{again ? "Checking this Payee again." : "Checking this Payee."} It is not added until the check finishes.</span>
    </p>
  );
}

/** How a Payee that was added got there, in the owner's own terms. */
function addedNote(row: PayeeRow): string {
  const kind = row.result?.verdict.verdict;
  if (kind === "warn") return "added after your confirmation";
  if (kind === "block") return "added anyway, after you typed its account id";
  return "added";
}

/**
 * The check of one picked Payee, under its row in the New Budget form: running, added, or waiting for the owner.
 * A Payee that waits is not in the Budget, and the line says so.
 */
function PayeeStatus({
  row,
  onDecide,
  onRemove,
  onRecheck,
  className,
}: {
  /** Undefined while a typed account waits for the field to rest. */
  row: PayeeRow | undefined;
  onDecide: () => void;
  onRemove: () => void;
  onRecheck: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  if (!row || row.state === "checking") {
    return (
      <div className={className}>
        <Checking />
      </div>
    );
  }
  if (row.state === "unavailable" || !row.result) {
    return (
      <div className={className}>
        <p className="flex items-start gap-1.5 text-xs">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium">Could not check - not added.</span> <span className="text-muted-foreground">{row.problem}</span>
          </span>
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={onRecheck}>
            <RotateCcw aria-hidden /> Check again
          </Button>
          <Button type="button" size="sm" variant="ghost" className={ROW_BUTTON} onClick={onRemove}>
            Do not add
          </Button>
        </div>
      </div>
    );
  }
  const { view, from, failed } = row.result;
  const added = row.state === "added";
  const top = view.signals[0];
  const more = view.signals.filter((s) => s.severity !== "info").length - 1;
  return (
    <div className={className} data-payee-state={row.state}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <PayeeVerdictMark verdict={view.verdict}>
          <span>
            {view.headline}
            <span className="font-normal text-muted-foreground"> - {added ? addedNote(row) : "not added yet"}</span>
          </span>
        </PayeeVerdictMark>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
          className="-my-2 inline-flex h-11 items-center gap-0.5 rounded text-xs text-muted-foreground hover:text-foreground sm:my-0 sm:h-6"
        >
          {open ? "Hide details" : "Details"}
          <ChevronDown aria-hidden className={cn("size-3.5 transition-transform duration-150", open && "rotate-180")} />
        </button>
      </div>
      {!added && !open && top && top.severity !== "info" && (
        <p className="mt-1 text-xs [overflow-wrap:anywhere] text-muted-foreground">
          <span className="font-medium text-foreground">{top.title}.</span> <VerdictWords accounts={accountsNamed(view)}>{top.reason}</VerdictWords>
          {more > 0 && ` And ${plural(more, "more reason")}.`}
        </p>
      )}
      {open && (
        <div id={detailsId} className="mt-2 rounded-lg border bg-rail p-3">
          <PayeeVerdict
            dense
            showPayee={false}
            view={view}
            from={from}
            action={
              added || failed ? (
                <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={onRecheck}>
                  <RotateCcw aria-hidden /> Check again
                </Button>
              ) : undefined
            }
          />
        </div>
      )}
      {!added && (
        <div className="mt-2 flex flex-wrap gap-2">
          {failed && (
            <Button type="button" size="sm" className={ROW_BUTTON} onClick={onRecheck}>
              <RotateCcw aria-hidden /> Check again
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" className={ROW_BUTTON} onClick={onDecide}>
            {row.state === "needs_typed_id" ? "Add anyway" : "Review and add"}
          </Button>
          <Button type="button" size="sm" variant="ghost" className={ROW_BUTTON} onClick={onRemove}>
            Do not add
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The owner's decision on a Payee the check did not clear. On "Ask a person first" a plain confirmation adds it. On
 * "Do not pay" the owner types the Payee's account id, so adding it is never one stray click.
 */
function PayeeDecisionDialog({ row, name, onClose, onAdd, onRemove }: { row: PayeeRow; name: string | null; onClose: () => void; onAdd: (typed?: string) => boolean; onRemove: () => void }) {
  const [typed, setTyped] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const declineRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  if (!row.result) return null;
  const { view, from } = row.result;
  const needsId = confirmationFor(view.verdict) === "type_id";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        sheetOnMobile
        className="gap-0 p-0 sm:max-w-xl max-sm:p-0"
        onOpenAutoFocus={(e) => {
          // Land on the safe choice, never on "add", and keep the verdict's first line in view.
          e.preventDefault();
          declineRef.current?.focus();
        }}
      >
        <DialogHeader className="border-b px-4 py-4 text-left sm:px-6">
          <DialogTitle className="pr-8 text-[0.9375rem] leading-[1.375rem]">{needsId ? "Add this Payee anyway?" : "Add this Payee to the Budget?"}</DialogTitle>
          <DialogDescription className="text-[0.8125rem]">
            {needsId
              ? "The check says not to pay this account. If you add it, the agent may pay it under this Budget."
              : "The check found something a person should look at. Read it, then decide."}{" "}
            Nothing is signed or sent by this choice.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (needsId && !typedIdMatches(row.payee, typed)) {
              setMismatch(true);
              inputRef.current?.focus();
              return;
            }
            if (!onAdd(needsId ? typed : undefined)) setMismatch(needsId);
          }}
        >
          <div className={cn("overflow-y-auto px-4 py-4 sm:px-6", needsId ? "max-h-[44dvh]" : "max-h-[60dvh]")}>
            <PayeeVerdict view={view} from={from} name={name} />
          </div>
          {/* The decision stays in view while the verdict scrolls. Sticky only in the bottom sheet, which scrolls itself; see TxFlow for why the centred dialog is not. */}
          <div className="border-t bg-background max-sm:sticky max-sm:bottom-0">
            {needsId && (
              <div className="space-y-1.5 px-4 pt-3 sm:px-6">
                <Label htmlFor="payee-confirm-id">Type the Payee&apos;s account id to add it anyway</Label>
                <p id="payee-confirm-hint" className="text-xs text-muted-foreground">
                  Type <AccountText value={row.payee} className="align-bottom text-foreground" /> exactly as shown.
                </p>
                <Input
                  ref={inputRef}
                  id="payee-confirm-id"
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setMismatch(false);
                  }}
                  aria-invalid={mismatch}
                  aria-describedby={mismatch ? "payee-confirm-error" : "payee-confirm-hint"}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="hash"
                />
                {mismatch && (
                  <p id="payee-confirm-error" role="alert" className="text-xs text-negative">
                    That does not match, so the Payee was not added. Type the account id exactly, with every dot and hyphen.
                  </p>
                )}
              </div>
            )}
            <DialogFooter className="gap-2 px-4 py-3 sm:px-6 max-sm:grid max-sm:grid-cols-2 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button ref={declineRef} type="button" variant="outline" className="max-sm:h-12 max-sm:rounded-xl" onClick={onRemove}>
                Do not add
              </Button>
              <Button type="submit" variant={needsId ? "destructive" : "default"} className="max-sm:h-12 max-sm:rounded-xl">
                {needsId ? "Add anyway" : "Add this Payee"}
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The typed accounts without one of them, one per line. */
function withoutAccount(text: string, account: string): string {
  return text
    .split(/[\s,]+/)
    .filter((t) => t && t !== account)
    .join("\n");
}

/**
 * The "Allowed Payees" part of the New Budget form. Every Payee the owner ticks or types is checked before it is
 * added: no concerns adds it quietly, "Ask a person first" needs a confirmation, and "Do not pay" needs the owner to
 * type the account id. A Payee that is not confirmed is not in the Budget's terms.
 */
export function AllowedPayeesField({
  providers,
  ticked,
  onTicked,
  typed,
  onTyped,
  typedError,
  payees,
  error,
}: {
  providers: Provider[] | undefined;
  ticked: NearAccount[];
  onTicked: (next: NearAccount[]) => void;
  typed: string;
  onTyped: (text: string) => void;
  /** Typed text that is not a NEAR account, said in one sentence. */
  typedError?: string;
  payees: BudgetPayees;
  /** Why the form cannot continue yet, shown once the owner tried. */
  error?: string;
}) {
  const [deciding, setDeciding] = useState<NearAccount | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    if (!MOCK_MODE) return;
    let live = true;
    void import("@/lib/mock/payee-check").then((m) => live && setHint(m.DEMO_PAYEE_HINT));
    return () => {
      live = false;
    };
  }, []);

  const nameOf = (payee: string) => providers?.find((p) => p.payee === payee)?.name ?? null;
  const typedAccounts = [...new Set(parseAccountList(typed).valid)].filter((p) => !ticked.includes(p));
  const remove = (payee: NearAccount) => {
    if (ticked.includes(payee)) onTicked(ticked.filter((x) => x !== payee));
    else onTyped(withoutAccount(typed, payee));
    setDeciding(null);
    toast("Payee not added", { description: "It is not in this Budget's allowed Payees." });
  };
  const decidingRow = deciding ? payees.row(deciding) : undefined;
  const dialogRow = decidingRow && (decidingRow.state === "needs_confirm" || decidingRow.state === "needs_typed_id") ? decidingRow : null;
  const status = (payee: NearAccount, className: string) => (
    <PayeeStatus row={payees.row(payee)} onDecide={() => setDeciding(payee)} onRemove={() => remove(payee)} onRecheck={() => payees.recheck(payee)} className={className} />
  );

  return (
    <fieldset>
      <legend className="text-sm font-medium">Allowed Payees</legend>
      <p className="mt-0.5 text-xs text-muted-foreground">Enforced on chain, at most 16. Leave everything unticked to allow any Payee. Each Payee is checked before it is added.</p>
      <div className="mt-3 divide-y rounded-lg border">
        {(providers ?? []).map((p) => {
          const on = ticked.includes(p.payee);
          return (
            <div key={p.id}>
              <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3.5 py-2.5 text-sm hover:bg-muted/40">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={on} onChange={() => onTicked(on ? ticked.filter((x) => x !== p.payee) : [...ticked, p.payee])} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    <Money atomic={p.priceAtomic} size="sm" /> per Call
                  </span>
                </span>
                <AccountId value={p.payee} copy={false} explorer={false} className="max-w-[45%] max-sm:hidden" idClassName="text-muted-foreground text-xs" />
              </label>
              {on && (
                <>
                  <p className="-mt-1.5 pr-3.5 pb-1 pl-[2.625rem] sm:hidden">
                    <AccountText value={p.payee} className="text-xs text-muted-foreground" />
                  </p>
                  {status(p.payee, "pr-3.5 pb-3 pl-[2.625rem]")}
                </>
              )}
            </div>
          );
        })}
        {providers?.length === 0 && <p className="px-3.5 py-3 text-sm text-muted-foreground">No Payees registered on this server yet. Add their accounts below.</p>}
      </div>
      <div className="mt-3 space-y-1.5">
        <Label htmlFor="extra" className="text-xs font-normal text-muted-foreground">
          Other Payee accounts, one per line
        </Label>
        <Textarea
          id="extra"
          rows={2}
          className="hash text-sm"
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          onBlur={payees.settleTyped}
          aria-invalid={Boolean(typedError)}
          aria-describedby={typedError ? "extra-error" : hint ? "extra-hint" : undefined}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {typedError && (
          <p id="extra-error" className="text-xs text-negative">
            {typedError}
          </p>
        )}
        {hint && (
          <p id="extra-hint" className="text-xs text-muted-foreground">
            <AccountSentence>{hint}</AccountSentence>
          </p>
        )}
      </div>
      {typedAccounts.length > 0 && (
        <ul aria-label="Typed Payee accounts" className="mt-3 divide-y rounded-lg border">
          {typedAccounts.map((p) => (
            <li key={p} className="px-3.5 py-3">
              <AccountId value={p} copy={false} explorer={false} />
              {status(p, "mt-1.5")}
            </li>
          ))}
        </ul>
      )}
      <PayeesProgress payees={payees} error={error} />
      {dialogRow && (
        <PayeeDecisionDialog
          key={dialogRow.payee}
          row={dialogRow}
          name={nameOf(dialogRow.payee)}
          onClose={() => setDeciding(null)}
          onRemove={() => remove(dialogRow.payee)}
          onAdd={(text) => {
            const added = payees.confirm(dialogRow.payee, text);
            if (added) setDeciding(null);
            return added;
          }}
        />
      )}
    </fieldset>
  );
}

/** One line on where the picked Payees stand, so a waiting Continue always has its reason next to it. */
function PayeesProgress({ payees, error }: { payees: BudgetPayees; error?: string }) {
  const { waiting, undecided, added } = payees;
  if (waiting.length === 0 && undecided.length === 0 && added.length === 0) return null;
  return (
    <div className="mt-3 text-xs" aria-live="polite">
      {waiting.length > 0 ? (
        <p className="flex items-start gap-1.5 text-muted-foreground">
          <Loader2 aria-hidden className="mt-px size-3.5 shrink-0 animate-spin" />
          Checking {plural(waiting.length, "Payee")}. Continue is available when the check finishes.
        </p>
      ) : undecided.length > 0 ? (
        <p className={cn("flex items-start gap-1.5", error ? "text-negative" : "text-foreground")}>
          <TriangleAlert aria-hidden className={cn("mt-px size-3.5 shrink-0", error ? "text-negative" : "text-warning")} />
          <span>
            {plural(undecided.length, "Payee")} {undecided.length === 1 ? "is" : "are"} not added yet. Add or remove {undecided.length === 1 ? "it" : "them"} to continue.
            {added.length > 0 && ` ${plural(added.length, "Payee")} added.`}
          </span>
        </p>
      ) : (
        <p className="text-muted-foreground">
          {plural(added.length, "Payee")} added. Only {added.length === 1 ? "this account" : "these accounts"} can be paid under this Budget.
        </p>
      )}
    </div>
  );
}
