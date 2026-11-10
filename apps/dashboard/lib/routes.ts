/**
 * Route facts shared by next.config.ts and the app shell: old URLs that moved (docs/PRODUCT.md section 2.4) and the
 * account screens that render without the signed-in shell (section 4.13). Kept free of Next.js imports for tests.
 */

export type Redirect = { source: string; destination: string; permanent: true };

/** `/operator/*` became `/platform/*`; Blocked merged the denials and screening pages. */
export const REDIRECTS: Redirect[] = [
  { source: "/operator", destination: "/platform/businesses", permanent: true },
  { source: "/operator/merchants", destination: "/platform/businesses", permanent: true },
  { source: "/operator/merchants/new", destination: "/platform/businesses/new", permanent: true },
  { source: "/operator/merchants/:id", destination: "/platform/businesses/:id", permanent: true },
  { source: "/platform", destination: "/platform/businesses", permanent: true },
  { source: "/denials", destination: "/blocked", permanent: true },
  { source: "/developers/screening", destination: "/blocked?tab=wallets", permanent: true },
  { source: "/settings/account", destination: "/account", permanent: true },
];

/** Where an old path goes, applying `:param` segments the way Next.js does; null when it did not move. */
export function redirectFor(pathname: string): string | null {
  const parts = pathname.replace(/\/+$/, "").split("/");
  for (const r of REDIRECTS) {
    const src = r.source.split("/");
    if (src.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < src.length; i++) {
      const s = src[i]!;
      if (s.startsWith(":")) params[s.slice(1)] = parts[i]!;
      else if (s !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return r.destination.replace(/:([a-z]+)/gi, (_, k: string) => params[k] ?? "");
  }
  return null;
}

/** Account screens: no shell, reachable signed out. */
const AUTH = [/^\/login\/?$/, /^\/setup\/?$/, /^\/signup\/?$/, /^\/signup\/pending\/?$/, /^\/forgot\/?$/, /^\/reset\/[^/]+\/?$/, /^\/verify\/[^/]+\/?$/, /^\/invite\/[^/]+\/?$/];

export function isAuthPath(pathname: string | null | undefined): boolean {
  return Boolean(pathname && AUTH.some((re) => re.test(pathname)));
}

/** Account screens a signed-in person may still open (an email link, an invite for a second business). */
export function isAuthPathForSignedIn(pathname: string): boolean {
  return /^\/(verify|invite|reset)\//.test(pathname) || /^\/signup\/pending\/?$/.test(pathname);
}

/** A safe in-app return path from `?next=`: same-origin paths only, never an account screen or a protocol URL. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  const path = next.split("?")[0]!;
  // An invite or verify link survives the trip through sign-in; other account screens do not.
  if (isAuthPath(path) && !/^\/(invite|verify)\//.test(path)) return "/";
  return next;
}

export function loginHref(next: string, reason?: "expired" | "signed_out" | "revoked" | null): string {
  const sp = new URLSearchParams();
  if (next && next !== "/") sp.set("next", next);
  if (reason) sp.set("reason", reason);
  const s = sp.toString();
  return `/login${s ? `?${s}` : ""}`;
}
