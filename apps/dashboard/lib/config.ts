/** Build-time configuration. NEXT_PUBLIC_* values are inlined by Next.js. */
export const NODE_URL = (process.env.NEXT_PUBLIC_NODE_URL || "http://localhost:8787").replace(/\/+$/, "");
/**
 * The NEAR RPC this browser reads proofs from (NEXT_PUBLIC_NEAR_RPC_URL). Unset, proofs read the network's public RPC,
 * never one the node chooses, except on a local sandbox, where the node's own RPC is the only one there is.
 */
export const RPC_URL_OVERRIDE = (process.env.NEXT_PUBLIC_NEAR_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "").replace(/\/+$/, "") || null;
/** "1" serves realistic fixtures; "empty" serves a fresh node so the first-run guide shows. */
export const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK === "1" || process.env.NEXT_PUBLIC_MOCK === "empty";
/**
 * The relayer that pays gas for an owner's revoke and reclaim (NEXT_PUBLIC_RELAYER_URL), as NEP-366 meta transactions.
 * Unset, the gasless path is not offered. It must sponsor this server's hub; the page checks its `/info` before signing.
 */
export const RELAYER_URL = (process.env.NEXT_PUBLIC_RELAYER_URL || "").replace(/\/+$/, "") || null;

export type LocalSigner = { url: string; token: string };

/**
 * The local signer of `pnpm local` (apps/local): a development tool that signs for local sandbox accounts in place of
 * a browser wallet, because no wallet can connect to a NEAR node on this machine. It is on only when the wallet network
 * is exactly `sandbox`, a signer URL and token are set, and that URL is plain http on a loopback address. On testnet or
 * mainnet this is null whatever else is set, and mock mode never uses it.
 */
export function localSigner(network: string | undefined, url: string | undefined, token: string | undefined, mock = false): LocalSigner | null {
  if (mock || network !== "sandbox" || !url || !token) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return { url: u.origin, token };
  } catch {
    return null;
  }
}

export const LOCAL_SIGNER = localSigner(process.env.NEXT_PUBLIC_NEAR_NETWORK, process.env.NEXT_PUBLIC_LOCAL_SIGNER_URL, process.env.NEXT_PUBLIC_LOCAL_SIGNER_TOKEN, MOCK_MODE);

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
