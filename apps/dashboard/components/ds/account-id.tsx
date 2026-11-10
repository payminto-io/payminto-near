"use client";

import { useExplorer } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { CopyButton, ExplorerLink } from "./actions";

/** How many characters middle truncation always keeps at the end, so `.testnet` and the last key bytes stay readable. */
export const ACCOUNT_TAIL = 8;

/** Splits an id for middle truncation: the head may shrink with an ellipsis, the tail never does. */
export function splitForMiddle(value: string, tail = ACCOUNT_TAIL): [string, string] {
  if (value.length <= tail + 4) return [value, ""];
  return [value.slice(0, -tail), value.slice(-tail)];
}

const isPublicKey = (v: string) => v.startsWith("ed25519:");
const IMPLICIT = /^[0-9a-f]{64}$/;

/**
 * An account id as text, with no hooks, for public pages (checkout, receipts) and dense rows: one line, never broken at
 * "-" or ".", the middle truncated only when space runs out, the full value in the title.
 */
export function AccountText({ value, className }: { value: string; className?: string }) {
  const [head, tail] = splitForMiddle(value);
  return (
    <span title={value} data-account={value} className={cn("inline-flex max-w-full min-w-0 font-mono whitespace-pre", className)}>
      <span className="truncate">{head}</span>
      {tail && <span className="shrink-0">{tail}</span>}
    </span>
  );
}

/** A named NEAR account inside a sentence: `name.testnet`, `dao.sputnik-v2.testnet`, `hub.near`. Never part of a host name. */
const ACCOUNT_IN_TEXT = /(?<![\w.-])[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:testnet|near)(?![\w-]|\.[a-z0-9])/g;

/** Splits a sentence into plain text and the named accounts in it, in order. Pure, for tests. */
export function splitAccounts(text: string): Array<{ text: string; account: boolean }> {
  const out: Array<{ text: string; account: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(ACCOUNT_IN_TEXT)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), account: false });
    out.push({ text: m[0], account: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), account: false });
  return out;
}

/**
 * A sentence that names accounts, such as a refusal from a wallet or a relayer. Each account is set as AccountText, so
 * it stays on one line and is never broken at "-" or ".", while the words around it wrap as usual.
 */
export function AccountSentence({ children }: { children: string }) {
  return (
    <>
      {splitAccounts(children).map((p, i) => (p.account ? <AccountText key={i} value={p.text} className="align-bottom text-[0.95em]" /> : p.text))}
    </>
  );
}

/**
 * A NEAR account id (up to 64 characters) or an `ed25519:` key, readable and copyable.
 * `wrap` shows every character, for anything a person must check; `middle` truncates the middle only when space runs
 * out, keeping the last 8 characters and the full value in the title. Copy always copies the full value.
 */
export function AccountId({
  value,
  mode = "middle",
  name,
  explorer = true,
  copy = true,
  className,
  idClassName,
}: {
  value: string | null | undefined;
  mode?: "wrap" | "middle";
  /** Friendly name shown before (middle) or above (wrap) the id. */
  name?: string | null;
  /** True links the account in the NEAR explorer; a string is the link itself. Keys never link. */
  explorer?: boolean | string;
  copy?: boolean;
  className?: string;
  idClassName?: string;
}) {
  const ex = useExplorer();
  if (!value) return <span className={cn("text-subtle", className)}>-</span>;
  const key = isPublicKey(value);
  const href = typeof explorer === "string" ? explorer : explorer && !key ? ex.address(value) : null;
  const what = key ? "key" : "account";
  const actions = (
    <>
      {copy && <CopyButton value={value} label={what} />}
      <ExplorerLink href={href} label={what} />
    </>
  );

  // A named account never wraps: a line break at "-" or "." reads as a different account. Only keys and implicit
  // (64 hex) accounts, which have no such characters, may break; a long named account truncates in the middle instead.
  if (mode === "wrap" && (key || IMPLICIT.test(value))) {
    return (
      <span className={cn("flex min-w-0 flex-col gap-0.5", className)}>
        {name && <span className="font-medium text-foreground">{name}</span>}
        <span className="flex min-w-0 items-start gap-1">
          <span className={cn("min-w-0 font-mono text-[0.8125rem] leading-[1.125rem] tracking-[-0.01em] [overflow-wrap:anywhere]", idClassName)} data-account={value}>
            {value}
          </span>
          <span className="-mt-0.5 flex shrink-0 items-center">{actions}</span>
        </span>
      </span>
    );
  }

  const [head, tail] = splitForMiddle(value);
  if (mode === "wrap") {
    return (
      <span className={cn("flex min-w-0 flex-col gap-0.5", className)}>
        {name && <span className="font-medium text-foreground">{name}</span>}
        <span className="flex min-w-0 items-center gap-1">
          <span title={value} data-account={value} className={cn("flex min-w-0 font-mono text-[0.8125rem] leading-[1.125rem] tracking-[-0.01em] whitespace-pre", idClassName)}>
            <span className="truncate">{head}</span>
            {tail && <span className="shrink-0">{tail}</span>}
          </span>
          <span className="flex shrink-0 items-center">{actions}</span>
        </span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1 align-middle", className)}>
      {name && <span className="truncate font-medium text-foreground">{name}</span>}
      <span
        title={value}
        data-account={value}
        className={cn("inline-flex min-w-0 font-mono text-[0.8125rem] leading-[1.125rem] tracking-[-0.01em]", name ? "text-muted-foreground" : "text-foreground", idClassName)}
      >
        <span className="truncate">{head}</span>
        {tail && <span className="shrink-0">{tail}</span>}
      </span>
      {actions}
    </span>
  );
}
