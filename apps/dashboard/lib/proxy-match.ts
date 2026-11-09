/**
 * Which requests for a shared link go to the node's x402 routes instead of the hosted page (GATEWAY.md section 5).
 * A browser asks for text/html and gets the checkout; an agent, curl or an x402 client gets the node's 402.
 * Kept free of Next.js imports so it is unit tested directly.
 */

type HeaderBag = { get(name: string): string | null };

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Requests the Next.js router makes for its own navigation; they must never be sent to the node. */
function isRouterRequest(h: HeaderBag): boolean {
  return Boolean(h.get("rsc") || h.get("next-router-prefetch") || h.get("next-router-state-tree") || h.get("next-action") || h.get("purpose") === "prefetch");
}

/** The node path for `/l/{slug}` and `/pay/{id}`, or null when the path is something else. */
export function x402PathFor(pathname: string): string | null {
  const m = /^\/(l|pay)\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  let segment: string;
  try {
    segment = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  if (!SEGMENT.test(segment)) return null;
  return m[1] === "l" ? `/v1/pay/l/${segment}` : `/v1/pay/${segment}`;
}

/**
 * The node path to rewrite to, or null to render the page.
 * A PAYMENT-SIGNATURE always goes to the node (it is a paid retry); otherwise anything that does not accept HTML does.
 */
export function x402Target(pathname: string, headers: HeaderBag): string | null {
  const path = x402PathFor(pathname);
  if (!path || isRouterRequest(headers)) return null;
  if (headers.get("payment-signature")) return path;
  const accept = (headers.get("accept") ?? "").toLowerCase();
  return accept.includes("text/html") ? null : path;
}

/**
 * The node path for a dashboard `/api/*` request (PRODUCT.md section 10.1), or null when it is not one the dashboard
 * forwards. Only the versioned API and the health check pass, so `/api` cannot reach the node's other routes.
 */
export function apiTarget(pathname: string): string | null {
  const m = /^\/api(\/.*)$/.exec(pathname);
  if (!m) return null;
  const rest = m[1]!;
  if (rest.split("/").some((s) => s === ".." || s === ".")) return null;
  if (rest === "/healthz") return rest;
  return /^\/v1\/[A-Za-z0-9._~%/-]*$/.test(rest) ? rest : null;
}
