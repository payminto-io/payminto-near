"use client";

/**
 * Budgets proposed to a DAO and not yet open on the hub. The server only registers a Budget the hub already holds, so
 * between "proposed" and "approved" the terms, the rules and the name live here, in this browser's localStorage. The
 * terms are also in the proposal on chain; the rules are not (only their hash is), which is why they are kept.
 *
 * Nothing secret is stored: the agent key is a public key and the salt only separates Budgets with equal terms.
 */
import { useSyncExternalStore } from "react";
import { z } from "zod";
import type { BudgetTermsJson, Id32, Policy } from "@payminto/protocol";
import { budgetJsonSchema, policySchema } from "./schemas";

const KEY = "payminto.daoBudgetDrafts.v1";

const draftSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  dao: z.string(),
  label: z.string(),
  budget: budgetJsonSchema,
  policy: policySchema,
  /** The first deposit proposed with it, atomic; "0" when none. */
  deposit: z.string().regex(/^\d+$/),
  proposedBy: z.string(),
  proposedAt: z.string(),
});
export type DaoBudgetDraft = Omit<z.infer<typeof draftSchema>, "budget" | "policy"> & { budget: BudgetTermsJson; policy: Policy };

const listeners = new Set<() => void>();
let cache: { raw: string | null; drafts: DaoBudgetDraft[] } = { raw: null, drafts: [] };
const NONE: DaoBudgetDraft[] = [];

function load(): DaoBudgetDraft[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return NONE; // Storage blocked: nothing was kept.
  }
  if (raw === cache.raw) return cache.drafts;
  let drafts: DaoBudgetDraft[] = [];
  try {
    const parsed = z.array(z.unknown()).parse(JSON.parse(raw ?? "[]"));
    // One unreadable entry never hides the others.
    drafts = parsed.flatMap((d) => {
      const r = draftSchema.safeParse(d);
      return r.success ? [r.data as DaoBudgetDraft] : [];
    });
  } catch {
    drafts = [];
  }
  cache = { raw, drafts };
  return drafts;
}

function store(drafts: DaoBudgetDraft[]): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    return false;
  }
  for (const l of listeners) l();
  return true;
}

export function readDaoDrafts(): DaoBudgetDraft[] {
  return typeof window === "undefined" ? NONE : load();
}

/** Keeps a proposed Budget. False when the browser would not store it (private mode, blocked site data). */
export function saveDaoDraft(d: DaoBudgetDraft): boolean {
  return store([d, ...readDaoDrafts().filter((x) => x.id !== d.id)]);
}

export function removeDaoDraft(id: Id32): void {
  store(readDaoDrafts().filter((x) => x.id !== id));
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => e.key === KEY && fn();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/** The proposed Budgets kept in this browser. Empty during server rendering and the first client render. */
export function useDaoDrafts(): DaoBudgetDraft[] {
  return useSyncExternalStore(subscribe, readDaoDrafts, () => NONE);
}
