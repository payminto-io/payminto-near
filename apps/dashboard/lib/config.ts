/** Build-time configuration. NEXT_PUBLIC_* values are inlined by Next.js. */
export const NODE_URL = (process.env.NEXT_PUBLIC_NODE_URL || "http://localhost:8787").replace(/\/+$/, "");
/**
 * Optional public chain RPC the browser reads for proofs and wallet chain setup, when the node does not publish one in
 * /v1/info. Needed for a local anvil on a non-default port; otherwise the network's default RPC is used.
 */
export const RPC_URL_OVERRIDE = (process.env.NEXT_PUBLIC_RPC_URL || "").replace(/\/+$/, "") || null;
/** "1" serves realistic fixtures; "empty" serves a fresh node so the first-run guide shows. */
export const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK === "1" || process.env.NEXT_PUBLIC_MOCK === "empty";

export function isLocalNode(url = NODE_URL): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

const LEGACY_TOKEN_KEY = "payminto.clearing.adminToken";
const RECOVERY_KEY = "payminto.recoveryKey";

/**
 * The recovery key (ADMIN_TOKEN) lives for this tab only, in sessionStorage; people sign in with email and a cookie
 * session (PRODUCT.md section 4.4). The old localStorage token from before accounts is dropped on first read.
 */
export function readRecoveryKey(): string | null {
  try {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // Storage blocked: nothing to clean up.
  }
  try {
    return window.sessionStorage.getItem(RECOVERY_KEY);
  } catch {
    return null;
  }
}

export function writeRecoveryKey(key: string | null): void {
  try {
    if (key) window.sessionStorage.setItem(RECOVERY_KEY, key);
    else window.sessionStorage.removeItem(RECOVERY_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the key then lasts until reload.
  }
}
