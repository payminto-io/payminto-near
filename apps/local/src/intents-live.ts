/**
 * `pnpm local --intents live`: the any-chain checkout against the real 1Click API and NEAR mainnet, while the hub, the
 * Budgets and everything else stay on the local chain. Real money moves when a buyer pays, so it is reachable only by
 * that flag (never an environment variable), refuses to start without the business's own NEAR mainnet account, says so
 * in a banner, and seeds nothing simulated. docs/LIVE_RUN.md is the walkthrough.
 *
 * This module only reads NEAR mainnet (two views of the payout account); it holds no key and sends nothing.
 */
import type { IntentsOption } from "./config.ts";

/** The published 1Click API the node talks to in live mode (the node refuses any other unless told). */
export const ONECLICK_LIVE_URL = "https://1click.chaindefuser.com";
/** The node's default NEAR mainnet RPC; `--intents-rpc` replaces it. */
export const DEFAULT_MAINNET_RPC = "https://rpc.mainnet.near.org";
/** Native USDC on NEAR mainnet, the token the merchant receives. */
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)+near$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const ETH_IMPLICIT = /^0x[0-9a-f]{40}$/;

/**
 * A NEAR mainnet account: a named `.near` account (not the `.test.near` names of the local chain), a 64-hex implicit
 * account, or an ETH-implicit `0x` account.
 */
export function isMainnetAccount(a: string): boolean {
  if (a.endsWith(".test.near")) return false;
  return NAMED.test(a) || IMPLICIT.test(a) || ETH_IMPLICIT.test(a);
}

/** The fake 1Click server and the local chain that stand in for mainnet, in simulated mode. */
export type SimulatedIntents = { baseUrl: string; managerPublicKey: string; rpcUrl: string; token: string; solver: string };

/**
 * The node's INTENTS_* settings. Live passes the mode and the operator's optional senders and RPC, and nothing of the
 * fake server: the node then uses the published 1Click URL and key and native USDC, and refuses anything else.
 */
export function intentsNodeEnv(i: IntentsOption, sim: SimulatedIntents | null): Record<string, string> {
  if (i.mode === "live") {
    return {
      INTENTS_CHECKOUT: "live",
      ...(i.senders.length ? { INTENTS_DELIVERY_SENDERS: i.senders.join(",") } : {}),
      ...(i.rpcUrl ? { NEAR_MAINNET_RPC_URL: i.rpcUrl } : {}),
    };
  }
  if (!sim) throw new Error("simulated mode needs the fake 1Click server");
  return {
    INTENTS_CHECKOUT: "simulated",
    ONECLICK_BASE_URL: sim.baseUrl,
    ONECLICK_MANAGER_PUBLIC_KEY: sim.managerPublicKey,
    NEAR_MAINNET_RPC_URL: sim.rpcUrl,
    INTENTS_USDC_CONTRACT: sim.token,
    INTENTS_DELIVERY_SENDERS: sim.solver,
  };
}

/** Printed first and again under the guide, so nobody misses it. */
export function liveBanner(payout: string): string[] {
  const rule = "=".repeat(100);
  return [
    rule,
    "  LIVE - real money on NEAR mainnet",
    "",
    `  The any-chain checkout talks to the real 1Click API (${ONECLICK_LIVE_URL}) and reads NEAR mainnet.`,
    `  A buyer's deposit is real money, and the USDC lands in ${payout} on NEAR mainnet.`,
    "  The hub, the Budgets, the NEAR wallet tab and every local account stay on this machine's local chain.",
    "  Nothing simulated is seeded: no fake 1Click server, and no simulated deposit buttons at checkout.",
    "  Stop with Ctrl-C. Walkthrough: docs/LIVE_RUN.md",
    rule,
  ];
}

export type MainnetPayout = { exists: boolean; registered: boolean };

/** Whether the payout account exists on NEAR mainnet and is registered with native USDC: two views, nothing sent. */
export async function readMainnetPayout(rpcUrl: string, account: string, f: typeof fetch = fetch, timeoutMs = 8_000): Promise<MainnetPayout> {
  const call = async (params: Record<string, unknown>) => {
    const r = await f(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "payminto-local", method: "query", params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await r.json()) as { result?: { amount?: string; result?: number[] }; error?: { cause?: { name?: string }; name?: string } };
  };
  const acct = await call({ request_type: "view_account", finality: "final", account_id: account });
  if (acct.error?.cause?.name === "UNKNOWN_ACCOUNT") return { exists: false, registered: false };
  if (acct.error || typeof acct.result?.amount !== "string") throw new Error(`view_account ${account}: ${acct.error?.cause?.name ?? acct.error?.name ?? "no answer"}`);
  const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
  const bal = await call({ request_type: "call_function", finality: "final", account_id: MAINNET_USDC, method_name: "storage_balance_of", args_base64: args });
  if (bal.error || !Array.isArray(bal.result?.result)) throw new Error(`storage_balance_of ${account}: ${bal.error?.cause?.name ?? bal.error?.name ?? "no answer"}`);
  return { exists: true, registered: JSON.parse(Buffer.from(bal.result.result).toString("utf8")) !== null };
}

/** One sentence on the payout account as read from NEAR mainnet, for the guide. */
export function payoutStatusText(payout: string, read: MainnetPayout | null): string {
  if (!read) return `${payout} could not be read from NEAR mainnet just now; the dashboard reads it again when you open its settings.`;
  if (!read.exists) return `${payout} does not exist on NEAR mainnet yet: create and fund it in your own wallet first (docs/LIVE_RUN.md step 1).`;
  return read.registered
    ? `${payout} exists on NEAR mainnet and is registered with USDC: it can receive the delivery.`
    : `${payout} exists on NEAR mainnet and is not registered with USDC yet: the dashboard shows the storage deposit (0.00125 NEAR) to send from your wallet.`;
}

/** How the node checks a live delivery, in the operator's words: what INTENTS_DELIVERY_SENDERS does and the fallback. */
export function deliveryCheckLines(i: Extract<IntentsOption, { mode: "live" }>): string[] {
  return [
    "How the node confirms a live payment. When 1Click says the USDC was delivered, the node reads the delivery transaction on",
    "NEAR mainnet itself and looks for USDC's NEP-141 ft_transfer to your account for at least the invoice amount (rpc_checked).",
    "NEAR RPC asks for the account that signed a transaction, so the node tries INTENTS_DELIVERY_SENDERS first (set here with",
    `--intents-senders a.near,b.near; now ${i.senders.length ? i.senders.join(", ") : "none"}) and then ${i.payout}. An RPC that tracks every shard, as`,
    `${i.rpcUrl ?? DEFAULT_MAINNET_RPC} does, finds the transaction under any of them, so none is needed there; an RPC that tracks`,
    "only some shards needs 1Click's signer, which you can only learn from an earlier delivery, and the flag is fixed for a run.",
    "If the node still cannot read the delivery (the RPC is down or rate limits it), it confirms on 1Click's word after 10 minutes",
    "and marks it provider_only: the dashboard then says \"Reported by 1Click only\". The proof page reads the delivery again in",
    "your browser either way.",
  ];
}
