/**
 * Which view is open (docs/PRODUCT.md section 3.5): the platform (all businesses, platform roles only) or one business.
 * Kept outside React so the HTTP clients read it per request (`Merchant-Id`, section 10.1); screens subscribe to
 * re-render. The choice is mirrored to the server as `last_business_id` and kept per tab in localStorage for a fast
 * first paint. On the platform view a detail page can name its business with `?b=mer_...` in the URL.
 */
export type View = { kind: "platform" } | { kind: "business"; merchantId: string };

const KEY = "payminto.view";
let current: View | null = null;
let loaded = false;
const listeners = new Set<() => void>();

export function parseView(raw: string | null | undefined): View | null {
  if (!raw) return null;
  if (raw === "platform") return { kind: "platform" };
  return /^mer_[A-Za-z0-9_-]{1,64}$/.test(raw) ? { kind: "business", merchantId: raw } : null;
}

export function serializeView(v: View): string {
  return v.kind === "platform" ? "platform" : v.merchantId;
}

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    current = parseView(window.localStorage.getItem(KEY));
  } catch {
    current = null;
  }
}

export function getView(): View | null {
  load();
  return current;
}

export function setView(v: View | null): void {
  load();
  const same = (a: View | null, b: View | null) => (a && b ? serializeView(a) === serializeView(b) : a === b);
  if (same(current, v)) return;
  current = v;
  try {
    if (v) window.localStorage.setItem(KEY, serializeView(v));
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage can be unavailable; the choice then lasts for this tab only.
  }
  for (const l of listeners) l();
}

export function subscribeView(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** `?b=mer_...` on the current URL, used by detail pages opened from the platform view. */
export function urlBusiness(search: string | null | undefined = typeof window === "undefined" ? null : window.location.search): string | null {
  if (!search) return null;
  const b = new URLSearchParams(search).get("b");
  return b && /^mer_[A-Za-z0-9_-]{1,64}$/.test(b) ? b : null;
}

/**
 * The business a request acts on, sent as `Merchant-Id`: the open business, or on the platform view the business a
 * shared URL names. Null on the platform view, where list routes return every business.
 */
export function getMerchantScope(): string | null {
  const v = getView();
  if (v?.kind === "business") return v.merchantId;
  return urlBusiness();
}

/** Back-compat for code written before views: subscribe to the same store. */
export const subscribeMerchantScope = subscribeView;

/** Adds `?b=` to an href on the platform view, so a pasted link opens the right business (section 3.5). */
export function withBusiness(href: string, merchantId: string | null | undefined): string {
  const v = getView();
  if (!merchantId || v?.kind !== "platform") return href;
  return `${href}${href.includes("?") ? "&" : "?"}b=${encodeURIComponent(merchantId)}`;
}

/** Legacy: the gateway clients treat any console credential as one that may name a business. */
export type Role = "operator" | "merchant";
export function roleOf(token: string): Role {
  return /^sk_(test|live)_/.test(token) ? "merchant" : "operator";
}
