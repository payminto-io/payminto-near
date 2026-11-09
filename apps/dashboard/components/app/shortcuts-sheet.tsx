"use client";

/** Help and keyboard shortcuts (`?`, PRODUCT.md section 7), with links to the docs and the HashKey Chain page. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Blocks, BookOpen } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { goShortcuts, navPages } from "@/lib/nav";
import { useNavModel } from "./sidebar";

const EVENT = "payminto:shortcuts";
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || null;

export function openShortcuts() {
  window.dispatchEvent(new CustomEvent(EVENT));
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 gap-1">
      {keys.map((k) => (
        <kbd key={k} className="hash min-w-6 rounded border bg-muted px-1.5 text-center text-xs leading-6">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutsSheet() {
  const [open, setOpen] = useState(false);
  const model = useNavModel();
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const go = goShortcuts(model);
  const pages = navPages(model);
  const rows: [string, string[]][] = [
    ["Search or jump to", ["Ctrl", "K"]],
    ["Search (when not typing)", ["/"]],
    ["Collapse or expand the sidebar", ["["]],
    ["Switch business", ["G", "B"]],
    ["This list", ["?"]],
    ...Object.entries(go)
      .filter(([k]) => k !== "b" || go.b)
      .map(([k, href]): [string, string[]] => [`Go to ${pages.find((p) => p.href === href)?.label ?? href}`, ["G", k.toUpperCase()]]),
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Help</DialogTitle>
          <DialogDescription>Keyboard shortcuts work anywhere in the dashboard while you are not typing. On a Mac use Cmd instead of Ctrl.</DialogDescription>
        </DialogHeader>
        <ul className="mt-2 divide-y text-sm">
          {rows.map(([label, keys]) => (
            <li key={label} className="flex items-center justify-between gap-4 py-2">
              <span>{label}</span>
              <Keys keys={keys} />
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link href="/developers/hashkey" onClick={() => setOpen(false)} className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors hover:bg-muted">
            <Blocks className="size-3.5" aria-hidden /> HashKey Chain resources
          </Link>
          {DOCS_URL && (
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors hover:bg-muted">
              <BookOpen className="size-3.5" aria-hidden /> Payminto docs
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
