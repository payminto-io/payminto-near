/**
 * The drop-in checkout (public/embed.js): a business adds one script tag and one button, and the hosted checkout opens
 * in a popup. The page that opened it is told when the payment changes state, through `postMessage` to the one origin
 * the script named in the URL fragment. The message is a convenience for the business's page; its webhook is the source
 * of truth for fulfilment.
 */
import type { CheckoutView } from "./schemas";

/** The fragment parameter embed.js adds: the origin of the page that opened the checkout. */
export const OPENER_PARAM = "payminto-origin";
const STORE_KEY = "payminto.opener-origin";

/** An `http(s)://host[:port]` origin from the fragment, or null for anything else (paths, other schemes, junk). */
export function parseOpenerOrigin(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get(OPENER_PARAM);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.origin !== raw.replace(/\/$/, "")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The fragment without the opener parameter, so the address bar shows the plain checkout address. */
export function withoutOpenerParam(hash: string): string {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  p.delete(OPENER_PARAM);
  const rest = p.toString();
  return rest ? `#${rest}` : "";
}

/**
 * Reads the opener's origin from the fragment once, keeps it for this window (the link page then moves to the
 * checkout page in the same popup) and cleans the address bar. Does nothing outside a popup.
 */
export function captureOpenerOrigin(): void {
  if (typeof window === "undefined") return;
  const origin = parseOpenerOrigin(window.location.hash);
  if (!origin) return;
  try {
    window.sessionStorage.setItem(STORE_KEY, origin);
  } catch {
    // Storage can be unavailable; the opener then simply hears nothing, and the webhook still tells the business.
  }
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${withoutOpenerParam(window.location.hash)}`);
}

export type PaymentMessage = { type: "payminto:payment"; id: string; status: CheckoutView["status"] };

export const paymentMessage = (view: Pick<CheckoutView, "id" | "status">): PaymentMessage => ({ type: "payminto:payment", id: view.id, status: view.status });

/** Tells the page that opened this checkout what state the payment is in, at its origin only. */
export function notifyOpener(view: Pick<CheckoutView, "id" | "status">): void {
  if (typeof window === "undefined" || !window.opener) return;
  let origin: string | null = null;
  try {
    origin = window.sessionStorage.getItem(STORE_KEY);
  } catch {
    origin = null;
  }
  if (!origin) return;
  try {
    (window.opener as Window).postMessage(paymentMessage(view), origin);
  } catch {
    // The opener navigated away or closed; nothing to tell.
  }
}

/** The two lines a business pastes into its site, with the link's slug filled in. */
export function embedSnippet(linkUrl: string, slug: string, label = "Pay with crypto"): { script: string; button: string; all: string; origin: string } {
  const origin = new URL(linkUrl).origin;
  const safeSlug = slug.replace(/[^A-Za-z0-9_-]/g, "");
  const safeLabel = label.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const script = `<script src="${origin}/embed.js" defer></script>`;
  const button = `<button type="button" data-payminto-link="${safeSlug}">${safeLabel}</button>`;
  return { script, button, all: `${script}\n${button}`, origin };
}
