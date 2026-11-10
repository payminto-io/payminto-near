/**
 * First-run setup, through the node's HTTP API and the local signer's HTTP API: the same requests the dashboard sends
 * when a person does this by hand. Nothing here touches the database or uses the recovery key.
 *
 *   1. the platform owner, with the one-time setup code the node printed to its log;
 *   2. a business with a payout account, proven with a NEP-413 signature by that account;
 *   3. a person for that business, invited by the owner and accepting the invite;
 *   4. an API key the business Admin creates, and a payment link made with it through the SDK's GatewayClient;
 *   4b. the business's NEAR account for payments from other chains (NEAR Intents, simulated), proven with a NEP-413
 *       signature, and the any-chain checkout turned on, with a second link for the returned-deposit walkthrough;
 *   5. the paid services (see services.ts);
 *   6. three Budgets, each opened and funded on chain by its owner and then registered with the node.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { intentsPayoutProofRequest, type AccountId, type Id32, type IntentsPayout, type Network, type Policy, type PublicKey, type WalletTx } from "@payminto/protocol";
import { GatewayClient, OwnerClient, signPayoutProof, type PayoutSigner } from "@payminto/sdk";
import { USDC, type LocalAccounts, type RoleKey } from "./accounts.ts";
import type { AgentDesk } from "./agents.ts";
import type { RegisteredService } from "./services.ts";
import { HttpError, NodeSession } from "./session.ts";

export type Login = { who: string; email: string; password: string };

export type SignerClient = {
  url: string;
  signAndSend(accountId: AccountId, transactions: WalletTx[]): Promise<Array<{ hash: string; ok: boolean; outcome: Record<string, unknown> }>>;
  signMessage(accountId: AccountId, message: string, recipient: string, nonce: Uint8Array): Promise<{ accountId: AccountId; publicKey: string; signature: string }>;
};

/** The local signer over HTTP, as the dashboard's driver calls it. */
export function signerClient(url: string, token: string, origin?: string): SignerClient {
  const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ network: "near:sandbox", ...body }) });
    const parsed = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
    if (!res.ok || !parsed) throw new Error(`local signer ${path} answered ${res.status}${parsed?.error?.code ? ` ${parsed.error.code}` : ""}${parsed?.error?.message ? `: ${parsed.error.message}` : ""}`);
    return parsed;
  };
  return {
    url,
    async signAndSend(accountId, transactions) {
      const { outcomes } = await post<{ outcomes: Array<Record<string, unknown>> }>("/v1/sign-and-send", { accountId, transactions });
      return outcomes.map((o) => {
        const status = o.status as Record<string, unknown> | string | undefined;
        return { hash: (o.transaction as { hash?: string } | undefined)?.hash ?? "", ok: !(status && typeof status === "object" && "Failure" in status), outcome: o };
      });
    },
    signMessage: (accountId, message, recipient, nonce) => post("/v1/sign-message", { accountId, message, recipient, nonce: Buffer.from(nonce).toString("base64") }),
  };
}

export type OwnerKey = "alice" | "bob" | "carol";
export type BudgetSeed = { key: OwnerKey; label: string; owner: AccountId; agentPk: PublicKey; budgetId: Id32; policy: Policy; payees: AccountId[]; escrow: bigint; cap: bigint };

export type SetupResult = {
  logins: Login[];
  /** The platform owner's session. */
  owner: NodeSession;
  /** The business Admin's session. */
  admin: NodeSession;
  /** The SDK's merchant client, holding the business's own API key. */
  gateway: GatewayClient;
  merchant: { id: string; name: string; payout: AccountId };
  link: { id: string; slug: string; url: string; title: string; amount: string };
  /** The any-chain checkout: the business's NEAR account for it, and the link of the returned-deposit walkthrough. */
  anyChain: { account: AccountId; link: { id: string; slug: string; url: string; title: string; amount: string } };
  budgets: Record<OwnerKey, BudgetSeed>;
};

export const PLATFORM_NAME = "Payminto Local";
export const BUSINESS_NAME = "Northwind Coffee";
export const OWNER_EMAIL = "owner@payminto.local";
export const MERCHANT_EMAIL = "merchant@payminto.local";

/** A password a person could type: four groups of letters and digits, about 95 bits. */
export function newPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]!);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

/** Writes the generated logins with mode 0600. The caller prints the path, never the contents. */
export function writeLogins(path: string, dashboardUrl: string, logins: readonly Login[], more: readonly string[] = []): void {
  const lines = [
    "Payminto local stack: generated logins.",
    "These exist only in this run's local database and are deleted with it. Never reuse them anywhere.",
    "",
    `Sign in at ${dashboardUrl}/login`,
    "",
    ...logins.flatMap((l) => [`${l.who}`, `  email:    ${l.email}`, `  password: ${l.password}`, ""]),
    ...more,
  ];
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  // writeFileSync applies the mode only when it creates the file.
  chmodSync(path, 0o600);
}

export const POLICIES: Record<OwnerKey, Policy> = {
  carol: { perCallCap: "50000", dailyCap: (2n * USDC).toString(), maxCallsPerMinute: 60, purpose: "Support agent: screens wallets before a refund" },
  alice: { perCallCap: "50000", dailyCap: (5n * USDC).toString(), maxCallsPerMinute: 120, purpose: "Research agent: buys quotes and wallet risk scans" },
  bob: { perCallCap: "50000", dailyCap: (5n * USDC).toString(), maxCallsPerMinute: 120, purpose: "Trading agent: buys research briefs and wallet risk scans" },
};

export async function runSetup(o: {
  nodeUrl: string;
  dashboardUrl: string;
  setupCode: string;
  network: Network;
  hub: AccountId;
  token: AccountId;
  settler: AccountId;
  accounts: LocalAccounts;
  signer: SignerClient;
  desk: AgentDesk;
  loginsPath: string;
  say: (line: string) => void;
  /** Called once the owner exists, to register the paid services before the Budgets name their payees. */
  registerServices: (owner: NodeSession) => Promise<RegisteredService[]>;
}): Promise<SetupResult> {
  const { say, accounts } = o;
  const logins: Login[] = [
    { who: "Platform owner (runs this server: Budgets, paid services, settlement, payouts, businesses)", email: OWNER_EMAIL, password: newPassword() },
    { who: `Business admin of ${BUSINESS_NAME} (payments, payment links, refunds)`, email: MERCHANT_EMAIL, password: newPassword() },
  ];
  // Written before the first account is created, so a run that stops half way still leaves the passwords it made.
  writeLogins(o.loginsPath, o.dashboardUrl, logins);

  // 1. The platform owner.
  const owner = new NodeSession({ baseUrl: o.nodeUrl, origin: o.dashboardUrl });
  await owner.setup({ code: o.setupCode, name: "Local Owner", email: OWNER_EMAIL, password: logins[0]!.password, platformName: PLATFORM_NAME });
  say(`   Platform owner ${OWNER_EMAIL} created with the setup code from the node's log (POST /v1/setup).`);

  // 2. The business. Its payout account proves control with a NEP-413 signature, built by the SDK's signPayoutProof
  //    and signed by the local signer, which is what the dashboard's wallet step does.
  const payout = accounts.by.merchant.accountId;
  const payoutSigner: PayoutSigner = {
    accountId: payout,
    signMessage: async (req) => {
      const s = await o.signer.signMessage(payout, req.message, req.recipient, req.nonce);
      return { signature: s.signature, publicKey: s.publicKey as PublicKey };
    },
  };
  const proof = await signPayoutProof(payoutSigner, "new", { network: o.network, hub: o.hub });
  const merchant = await owner.post<{ id: string; name: string; payout: AccountId }>("/v1/merchants", { name: BUSINESS_NAME, support_email: "hello@northwind.local", payout: proof });
  say(`   Business ${merchant.name} (${merchant.id}) created; ${payout} proved it is the payout account with a NEP-413 signature.`);

  // 3. A person for the business: the owner invites, the invited person accepts with the link from the email outbox.
  const scope = { "Merchant-Id": merchant.id };
  await owner.post("/v1/invites", { emails: [MERCHANT_EMAIL], role: "admin" }, scope);
  const token = await inviteToken(owner, MERCHANT_EMAIL);
  const admin = new NodeSession({ baseUrl: o.nodeUrl, origin: o.dashboardUrl });
  await admin.post("/v1/invites/accept", { token, name: "Nora Northwind", password: logins[1]!.password });
  await admin.login(MERCHANT_EMAIL, logins[1]!.password);
  say(`   ${MERCHANT_EMAIL} accepted the owner's invite and is Admin of ${merchant.name}.`);

  // 4. The business's own software: its Admin creates an API key (Developers, API keys), and the SDK's GatewayClient
  //    uses that key from here on, as the business's server would. The first thing it makes is a payment link.
  const key = await admin.post<{ id: string; secret: string }>("/v1/api-keys", { name: "Local stack" });
  writeLogins(o.loginsPath, o.dashboardUrl, logins, [`API key of ${BUSINESS_NAME} (Authorization: Bearer ...), for the SDK's GatewayClient or curl against ${o.nodeUrl}`, `  ${key.secret}`, ""]);
  const gateway = new GatewayClient({ nodeUrl: o.nodeUrl, apiKey: key.secret });
  const linkAmount = (4n * USDC + 500_000n).toString();
  const link = await gateway.links.create({ title: "Bag of beans, 250 g", description: "Single origin, roasted this week.", amount: linkAmount, collect_email: false });
  say(`   API key ${key.id} created by the business Admin; with it the SDK created the payment link "${link.title}" for 4.50 USDC: ${link.url}`);

  // 4b. Payments from other chains (NEAR Intents, simulated here). The business proves its NEAR account with a NEP-413
  //     message signed by that account, as the dashboard's wallet step does; the account registered itself with the
  //     token when it was created, so every check passes and the Admin can turn the method on.
  const anyAccount = accounts.by.anychain.accountId;
  const timestamp = Math.floor(Date.now() / 1000);
  const req = intentsPayoutProofRequest(merchant.id, anyAccount, timestamp, { settlementNetwork: "near:mainnet (simulated)", hub: o.hub });
  const signed = await o.signer.signMessage(anyAccount, req.message, req.recipient, req.nonce);
  const anyPayout = await admin.request<IntentsPayout>("PUT", "/v1/merchant/intents-payout", { account: anyAccount, proof: { timestamp, public_key: signed.publicKey, signature: signed.signature } }, scope);
  if (!anyPayout.verified) throw new Error(`the any-chain payout account did not pass its checks: ${JSON.stringify(anyPayout.checks)}`);
  await admin.request("PUT", `/v1/merchants/${merchant.id}/methods`, { methods: [{ method: "oneclick", enabled: true }] }, scope);
  const anyLinkAmount = (2n * USDC).toString();
  const anyLink = await gateway.links.create({ title: "Gift card, 2 USDC (any-chain returned-deposit demo)", description: "Pay it from another chain and send too little: NEAR Intents returns the deposit.", amount: anyLinkAmount, collect_email: false });
  say(`   ${anyAccount} proved it is ${merchant.name}'s account for payments from other chains (NEAR Intents, simulated), and the Admin turned the method on; second link: ${anyLink.url}`);

  // 5. Paid services.
  const services = await o.registerServices(owner);
  for (const s of services) say(`   Paid service ${s.name} (${s.id}), ${Number(s.priceAtomic) / 1e6} USDC per call, paid to ${s.payee}.`);

  // 6. Budgets: each owner signs open_budget and the first deposit with the local signer, then the node registers it.
  const seeds: Array<{ key: OwnerKey; label: string; payees: RoleKey[]; also?: AccountId[]; cap: bigint; escrow: bigint }> = [
    // The new vendor is on Alice's payee list, so the Budget allows it; the payee check still asks her before the first payment.
    { key: "alice", label: "Research agent", payees: ["bob", "seller"], also: [accounts.vendor], cap: 25n * USDC, escrow: 5n * USDC },
    { key: "bob", label: "Trading agent", payees: ["alice", "seller"], cap: 25n * USDC, escrow: 5n * USDC },
    // Carol's NEAR is taken away after this (see stack.ts), so her Budget is the one to revoke through the relayer.
    { key: "carol", label: "Support agent", payees: ["seller"], cap: 10n * USDC, escrow: 1n * USDC },
  ];
  const budgets = {} as Record<OwnerKey, BudgetSeed>;
  await Promise.all(
    seeds.map(async (s) => {
      const account = accounts.by[s.key].accountId;
      const agent = o.desk.newKey(s.label);
      const client = new OwnerClient({ nodeUrl: o.nodeUrl, network: o.network, hub: o.hub, token: o.token, owner: account, settler: o.settler, fetch: owner.fetch });
      const payees = [...s.payees.map((p) => accounts.by[p].accountId), ...(s.also ?? [])];
      const { cap, escrow } = s;
      const policy = POLICIES[s.key];
      const { terms, budgetId } = client.createBudget({ agentPk: agent.keypair.publicKey, cap, validForSeconds: 30 * 86_400, payees, policy });
      const sent = await o.signer.signAndSend(account, [client.openTx(terms), client.depositTx(budgetId, escrow)]);
      const failed = sent.find((x) => !x.ok);
      if (sent.length !== 2 || failed) throw new Error(`${account} could not open and fund its Budget: ${JSON.stringify(failed?.outcome.status ?? "a transaction was not sent")}`);
      await client.submit({ terms, policy, label: s.label });
      budgets[s.key] = { key: s.key, label: s.label, owner: account, agentPk: agent.keypair.publicKey, budgetId, policy, payees, escrow, cap };
      say(`   Budget "${s.label}" ${budgetId.slice(0, 8)}... opened by ${account} (tx ${sent[0]!.hash}), funded with ${escrow / USDC} USDC (tx ${sent[1]!.hash}), registered with the node.`);
    }),
  );

  return { logins, owner, admin, gateway, merchant: { id: merchant.id, name: merchant.name, payout }, link: { id: link.id, slug: link.slug, url: link.url, title: link.title, amount: linkAmount }, anyChain: { account: anyAccount, link: { id: anyLink.id, slug: anyLink.slug, url: anyLink.url, title: anyLink.title, amount: anyLinkAmount } }, budgets };
}

type OutboxEmail = { to?: string; to_email?: string; subject?: string; body?: string; text?: string; link?: string; url?: string };

/** The invite link's token, read from the node's email outbox as the owner (with no SMTP, emails stay there). */
async function inviteToken(owner: NodeSession, email: string): Promise<string> {
  const out = await owner.get<{ items?: OutboxEmail[] } | OutboxEmail[]>("/v1/platform/outbox");
  const items = Array.isArray(out) ? out : (out.items ?? []);
  for (const m of items) {
    const text = JSON.stringify(m);
    if (!text.includes(email)) continue;
    const found = /\/invite\/([A-Za-z0-9_-]{16,})/.exec(text);
    if (found) return found[1]!;
  }
  throw new HttpError("GET", "/v1/platform/outbox", 200, { error: { code: "NO_INVITE", message: `no invite email for ${email} in the outbox` } });
}
