/**
 * The getting-started checklist on a business's Home: each step's done state comes from data the dashboard already
 * reads, and a step shows only to someone who can act on it. Pure, so the step rules are unit tested.
 */
import type { Permission } from "./permissions";
import type { PayoutHistory } from "./platform-schemas";

export type AnyChainState = "on" | "off" | "unavailable";

/** What the checklist reads. Counts are of what exists now; `team` counts members plus invites waiting. */
export type ChecklistFacts = {
  payoutProven: boolean;
  anyChain: AnyChainState;
  links: number;
  team: number;
  apiKeys: number;
  paidPayments: number;
};

export type StepKey = "payout" | "anyChain" | "link" | "team" | "apiKey" | "firstPayment";

export type ChecklistStep = { key: StepKey; title: string; body: string; href: string; action: string; done: boolean };

type StepDef = Omit<ChecklistStep, "done"> & { permission: Permission; done: (f: ChecklistFacts) => boolean; offered?: (f: ChecklistFacts) => boolean };

const STEPS: StepDef[] = [
  {
    key: "payout",
    title: "Prove your payout account",
    body: "Sign once with the wallet your money goes to, so nobody can redirect it.",
    href: "/settings/payout",
    action: "Prove payout account",
    permission: "payout.change",
    done: (f) => f.payoutProven,
  },
  {
    key: "anyChain",
    title: "Accept any chain",
    body: "Customers pay from other chains, and USDC lands in your own NEAR account.",
    href: "/settings/methods",
    action: "Turn on any chain",
    permission: "business.update",
    done: (f) => f.anyChain === "on",
    offered: (f) => f.anyChain !== "unavailable",
  },
  {
    key: "link",
    title: "Create a payment link",
    body: "A link anyone can pay, people or AI agents. Share it anywhere.",
    href: "/links/new",
    action: "Create a link",
    permission: "links.write",
    done: (f) => f.links > 0,
  },
  {
    key: "team",
    title: "Invite your team",
    body: "Add an Admin, Staff or Viewer so you are not the only one who can help.",
    href: "/settings/team?invite=1",
    action: "Invite people",
    permission: "members.manage",
    done: (f) => f.team > 1,
  },
  {
    key: "apiKey",
    title: "Create an API key",
    body: "Lets your own software create payments and read them.",
    href: "/developers/keys",
    action: "Create a key",
    permission: "developers.manage",
    done: (f) => f.apiKeys > 0,
  },
  {
    key: "firstPayment",
    title: "Get your first payment",
    body: "Share a link or your checkout. The first paid payment finishes setup.",
    href: "/links",
    action: "Share a link",
    permission: "links.write",
    done: (f) => f.paidPayments > 0,
  },
];

/** The steps this person sees, in order, with their done state. */
export function checklistSteps(facts: ChecklistFacts, can: (p: Permission) => boolean): ChecklistStep[] {
  return STEPS.filter((s) => can(s.permission) && (s.offered?.(facts) ?? true)).map(({ permission: _p, done, offered: _o, ...s }) => (void _p, void _o, { ...s, done: done(facts) }));
}

export function checklistProgress(steps: readonly ChecklistStep[]): { done: number; total: number; label: string; complete: boolean } {
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, label: `${done} of ${steps.length}`, complete: done === steps.length };
}

/** Today's payout account is proven when the newest change set it with a signature. The demo sends no history. */
export function payoutProven(p: PayoutHistory): boolean {
  if (!p.payout) return false;
  if (!p.payout_history) return true;
  const last = p.payout_history[0];
  return Boolean(last && last.proven && last.new_payout === p.payout);
}

/** The any-chain method is listed only on a server that runs the any-chain checkout. */
export function anyChainState(methods: readonly { method: string; enabled: boolean }[]): AnyChainState {
  const m = methods.find((x) => x.method === "oneclick");
  return !m ? "unavailable" : m.enabled ? "on" : "off";
}

const dismissKey = (merchantId: string) => `payminto.setup-checklist.dismissed.${merchantId}`;

function storage(s?: Storage): Storage | null {
  if (s) return s;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Storage can be blocked or full; the checklist then simply shows again. */
export function isChecklistDismissed(merchantId: string, s?: Storage): boolean {
  try {
    return storage(s)?.getItem(dismissKey(merchantId)) === "1";
  } catch {
    return false;
  }
}

export function dismissChecklist(merchantId: string, s?: Storage): void {
  try {
    storage(s)?.setItem(dismissKey(merchantId), "1");
  } catch {
    // The dismissal then lasts for this page view only.
  }
}
