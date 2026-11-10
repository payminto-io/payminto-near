/**
 * `payminto-agent serve-skill market-brief`: starts the seller agent from the environment.
 * It needs its own agent key and budget (to buy inputs) and a provider registration on the node: either an existing
 * one (SELLER_PROVIDER_ID + SELLER_PROVIDER_API_KEY) or one it creates by signing in as the platform operator.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { isAccountId, isPublicKey, keypairFromSeed, type Keypair, type PublicKey } from "@payminto/protocol";
import { AgentClient, AgentKeyFileError, defaultAgentKeyPath, FileVoucherStore, NodeHttp, readAgentKeyFile } from "@payminto/sdk";
import type { ModelClient } from "@payminto/models";
import { AgentConfigError, MissingApiKeyError, modelFromEnv } from "./config.ts";
import { discoverInputs, marketBriefApp, registerSeller, SKILL_NAME, type BriefInputs } from "./seller.ts";
import { listen, type Listening } from "./service.ts";

type Env = Record<string, string | undefined>;

const hex32 = (what: string) => z.string().regex(/^[0-9a-f]{64}$/, `must be a 32-byte ${what} as 64 lowercase hex characters`);
const account = z.string().refine((v) => isAccountId(v), "must be a NEAR account id");
const sellerSchema = z.object({
  NODE_URL: z.url("must be the clearing node base URL"),
  /** Override: the seller's seed in the environment. Prefer SELLER_AGENT_KEY_FILE, written by `payminto-agent keygen`. */
  SELLER_AGENT_KEY: hex32("ed25519 seed").optional(),
  SELLER_AGENT_KEY_FILE: z.string().min(1).optional(),
  /** The seller's latest voucher per Budget, for settle_own. Defaults under PAYMINTO_DATA_DIR. */
  SELLER_VOUCHER_STORE_PATH: z.string().min(1).optional(),
  /** The NEAR account paid for each brief. The agent key has no account of its own. */
  SELLER_PAYEE: account,
  SELLER_BUDGET_ID: hex32("budget id"),
  SELLER_PRICE_ATOMIC: z.string().regex(/^[1-9]\d*$/).default("30000"),
  SELLER_PORT: z.string().regex(/^\d+$/).default("4190"),
  SELLER_HOST: z.string().default("127.0.0.1"),
  SELLER_PUBLIC_URL: z.url().optional(),
  SELLER_PROVIDER_ID: z.string().min(1).optional(),
  SELLER_PROVIDER_API_KEY: z.string().min(1).optional(),
  SELLER_RECEIPT_STORE_PATH: z.string().min(1).optional(),
  SELLER_QUOTE_URL: z.url().optional(),
  SELLER_RISK_URL: z.url().optional(),
  TRUSTED_NODE_KEY: z.string().refine((v) => isPublicKey(v), "must be an ed25519:<base58> public key").optional(),
  PAYMINTO_DATA_DIR: z.string().min(1).optional(),
  PAYMINTO_OPERATOR_EMAIL: z.string().min(3).optional(),
  PAYMINTO_OPERATOR_PASSWORD: z.string().min(1).optional(),
  PAYMINTO_DASHBOARD_URL: z.url().optional(),
});

const infoSchema = z.object({ hub: z.string(), network: z.object({ id: z.enum(["near:testnet", "near:sandbox"]) }).loose(), token: z.object({ symbol: z.string(), decimals: z.number() }).loose() }).loose();
const catalogSchema = z.array(z.object({ id: z.string(), priceAtomic: z.string(), payee: z.string() }).loose());

/** Signs in as the platform operator the way the dashboard does (session cookie, CSRF header, dashboard Origin). */
async function operatorFetch(nodeUrl: string, email: string, password: string, origin: string): Promise<typeof fetch> {
  const res = await fetch(`${nodeUrl}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email, password }) });
  const body = (await res.json().catch(() => null)) as { csrf_token?: string; error?: { code: string } } | null;
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((kv) => kv.startsWith("pm_session=") || kv.startsWith("__Host-pm_session="));
  if (!res.ok || !body?.csrf_token || !cookie) throw new Error(`operator sign-in failed: ${body?.error?.code ?? `HTTP ${res.status}`}`);
  const csrf = body.csrf_token;
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    headers.set("origin", origin);
    if ((init.method ?? "GET").toUpperCase() !== "GET") headers.set("x-payminto-csrf", csrf);
    return fetch(input, { ...init, headers });
  };
}

export type RunningSeller = { url: string; providerId: string; seller: string; price: bigint; close(): Promise<void> };

export async function serveMarketBrief(env: Env = process.env, log: (s: string) => void = () => {}): Promise<RunningSeller> {
  const p = sellerSchema.safeParse(env);
  if (!p.success) throw new AgentConfigError(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const e = p.data;
  const nodeUrl = e.NODE_URL.replace(/\/+$/, "");
  let model: ModelClient | null = null;
  let unavailable: string | undefined;
  try {
    model = modelFromEnv(env);
  } catch (err) {
    if (!(err instanceof MissingApiKeyError)) throw err;
    unavailable = `this seller has no model configured (${err.variable} is not set on its server); nothing was charged`;
    log(`${err.variable} is not set: the skill is listed but answers 503 MODEL_UNAVAILABLE (before any payment) until it is`);
  }

  const node = new NodeHttp(nodeUrl);
  const info = await node.get("/v1/info", infoSchema);
  let keypair: Keypair;
  try {
    keypair = e.SELLER_AGENT_KEY ? keypairFromSeed(Uint8Array.from(Buffer.from(e.SELLER_AGENT_KEY, "hex"))) : readAgentKeyFile(e.SELLER_AGENT_KEY_FILE ?? defaultAgentKeyPath(env));
  } catch (err) {
    throw new AgentConfigError([`SELLER_AGENT_KEY_FILE: ${err instanceof AgentKeyFileError ? err.message : "cannot read the key file"}`]);
  }
  const payee = e.SELLER_PAYEE;
  const price = BigInt(e.SELLER_PRICE_ATOMIC);
  const port = Number(e.SELLER_PORT);
  const publicUrl = (e.SELLER_PUBLIC_URL ?? `http://${e.SELLER_HOST}:${port}`).replace(/\/+$/, "");

  let provider: { id: string; apiKey: string };
  if (e.SELLER_PROVIDER_ID && e.SELLER_PROVIDER_API_KEY) {
    provider = { id: e.SELLER_PROVIDER_ID, apiKey: e.SELLER_PROVIDER_API_KEY };
    const listed = (await node.get("/v1/providers", catalogSchema)).find((x) => x.id === provider.id);
    if (!listed) throw new AgentConfigError([`SELLER_PROVIDER_ID: ${provider.id} is not registered at ${nodeUrl}`]);
    if (BigInt(listed.priceAtomic) !== price) throw new AgentConfigError([`SELLER_PRICE_ATOMIC: ${price} differs from the registered price ${listed.priceAtomic}`]);
  } else if (e.PAYMINTO_OPERATOR_EMAIL && e.PAYMINTO_OPERATOR_PASSWORD && e.PAYMINTO_DASHBOARD_URL) {
    const f = await operatorFetch(nodeUrl, e.PAYMINTO_OPERATOR_EMAIL, e.PAYMINTO_OPERATOR_PASSWORD, new URL(e.PAYMINTO_DASHBOARD_URL).origin);
    provider = await registerSeller(new NodeHttp(nodeUrl, { fetch: f }), { payee, price, resource: `${publicUrl}/v1/brief` });
    log(`registered provider ${provider.id} (${SKILL_NAME}) paying ${payee}; set SELLER_PROVIDER_ID=${provider.id} and SELLER_PROVIDER_API_KEY to reuse it`);
  } else {
    throw new AgentConfigError([
      "SELLER_PROVIDER_ID and SELLER_PROVIDER_API_KEY: register the skill as a provider first (Agents > Providers), or set PAYMINTO_OPERATOR_EMAIL, PAYMINTO_OPERATOR_PASSWORD and PAYMINTO_DASHBOARD_URL to register it now",
    ]);
  }

  const storePath = resolve(
    e.SELLER_RECEIPT_STORE_PATH ?? join(e.PAYMINTO_DATA_DIR ?? join(homedir(), ".payminto"), "agent", `seller-${info.network.id.replace(":", "-")}-${keypair.publicKey.slice("ed25519:".length)}.db`),
  );
  const buyer = new AgentClient({
    network: info.network.id,
    hub: info.hub,
    nodeUrl,
    keypair,
    budgetId: e.SELLER_BUDGET_ID,
    storePath,
    trustedNodeKey: e.TRUSTED_NODE_KEY as PublicKey | undefined,
  });
  buyer.on("error", (err) => log(`seller wallet: ${err.message}`));
  const voucherPath = resolve(
    e.SELLER_VOUCHER_STORE_PATH ?? join(e.PAYMINTO_DATA_DIR ?? join(homedir(), ".payminto"), "agent", `seller-vouchers-${info.network.id.replace(":", "-")}-${payee}.json`),
  );
  const vouchers = new FileVoucherStore(voucherPath);
  log(`latest vouchers per Budget kept in ${voucherPath} for settle_own`);
  const inputs: BriefInputs | (() => Promise<BriefInputs>) =
    e.SELLER_QUOTE_URL && e.SELLER_RISK_URL ? { quoteUrl: e.SELLER_QUOTE_URL, riskUrl: e.SELLER_RISK_URL } : () => discoverInputs(nodeUrl, provider.id);
  const app = marketBriefApp({ nodeUrl, provider, price, buyer, inputs, model, modelUnavailable: unavailable, token: info.token, vouchers });
  let server: Listening;
  try {
    server = await listen(app, port, e.SELLER_HOST);
  } catch (err) {
    buyer.close();
    vouchers.close();
    throw err;
  }
  return {
    url: `${publicUrl}/v1/brief`,
    providerId: provider.id,
    seller: payee,
    price,
    async close() {
      await server.close();
      buyer.close();
      vouchers.close();
    },
  };
}
