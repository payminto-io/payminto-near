/**
 * Accounts, sessions, permissions, search and customers (docs/PRODUCT.md sections 4, 5 and 10), end to end over HTTP
 * against a node on anvil with the gateway on and workers off: first-run setup with the logged code, the recovery key
 * rules, sign-in and lockout, cookie attributes and CSRF, rotation and expiry, invites, the role matrix with
 * cross-business isolation, Staff refund requests, password reset, sign-up with approval, the email outbox, the
 * activity log, global search scoping, customers, step-up, auth rate limits, and the carry-over API changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Abi, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { depositFactoryAbi, depositFactoryBytecode, payoutChangeMessage, paymentRouterAbi, paymentRouterBytecode } from "@payminto/protocol";
import { startNode, type ClearingNode } from "../src/server.ts";
import { createLogger } from "../src/logger.ts";
import { hashPassword, passwordProblem, verifyPassword } from "../src/auth/passwords.ts";
import { sendSmtp } from "../src/auth/mailer.ts";
import type { GatewayConfig } from "../src/config.ts";
import { ANVIL_KEYS, deployClearing, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const DASH = "http://localhost:3000";
const PAYOUT = privateKeyToAccount(ANVIL_KEYS[6]);
const PAYOUT_B = privateKeyToAccount(ANVIL_KEYS[5]);
const FEES = privateKeyToAccount(ANVIL_KEYS[7]).address;
const OWNER_PW = "owner-correct-horse-42";
const PW = "a-long-enough-passphrase-9";

let anvil: Anvil;
let node: ClearingNode;
let hub: Address;
let gatewayCfg: GatewayConfig;
let token: Address;
const logs: string[] = [];
const tmp = tempDir("payminto-accounts-");
const tmp2 = tempDir("payminto-accounts-limits-");

type Res = { status: number; json: any; headers: Headers; cookies: string[] };

/** A browser: keeps the session cookie and the CSRF token, sends the dashboard Origin. */
class Browser {
  cookie: string | null = null;
  csrf: string | null = null;
  readonly base: () => string;
  readonly origin: string | null;
  constructor(base: () => string, origin: string | null = DASH) {
    this.base = base;
    this.origin = origin;
  }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { "content-type": "application/json", ...(this.origin ? { origin: this.origin } : {}) };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== "GET") h["x-payminto-csrf"] = this.csrf;
    const all = Object.fromEntries(Object.entries({ ...h, ...headers }).filter(([, v]) => v !== ""));
    const res = await fetch(`${this.base()}${path}`, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookies = res.headers.getSetCookie();
    for (const c of cookies) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      const name = kv!.slice(0, i);
      const value = kv!.slice(i + 1);
      if (name === "pm_session" || name === "__Host-pm_session") this.cookie = value ? `${name}=${value}` : null;
    }
    const text = await res.text();
    const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
    if (json && typeof json === "object" && "csrf_token" in json && json.csrf_token) this.csrf = json.csrf_token;
    return { status: res.status, json, headers: res.headers, cookies };
  }
  get = (p: string, h?: Record<string, string>) => this.req("GET", p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.req("POST", p, b ?? {}, h);
  patch = (p: string, b?: unknown, h?: Record<string, string>) => this.req("PATCH", p, b ?? {}, h);
  del = (p: string, h?: Record<string, string>) => this.req("DELETE", p, undefined, h);
}

async function bearer(method: string, path: string, auth: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${node.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: res.headers, cookies: res.headers.getSetCookie() };
}

const auth = () => node.services.auth;
const setupCodeFromLogs = () => {
  const line = [...logs].reverse().find((l) => l.includes("[setup]"));
  return /enter code ([A-Z2-7-]+)/.exec(line ?? "")?.[1] ?? null;
};
/** The newest outbox link of a kind for an address. */
const outboxLink = (to: string, kind: string) =>
  node.services.db.get<{ link: string }>("SELECT link FROM outbox_emails WHERE to_addr = ? AND kind = ? ORDER BY id DESC LIMIT 1", to, kind)?.link ?? null;
const tokenOf = (link: string | null) => link!.split("/").pop()!;
const scope = () => ({ chainId: 31337, hub });
const nowSec = () => Math.floor(Date.now() / 1000);

let owner: Browser;
let merchantA: string;
let merchantB: string;

async function newBusiness(name: string, payout = PAYOUT_B): Promise<string> {
  const ts = nowSec();
  const r = await owner.post("/v1/merchants", {
    name,
    payout: { payout: payout.address, timestamp: ts, signature: await payout.signMessage({ message: payoutChangeMessage("new", payout.address, ts, scope()) }) },
  });
  expect(r.status).toBe(201);
  return r.json.id;
}

/** Invites `email` to a business as `role` and accepts it in a fresh browser. */
async function member(by: Browser, merchantId: string, email: string, role: "admin" | "staff" | "viewer"): Promise<Browser> {
  const inv = await by.post("/v1/invites", { emails: [email], role }, { "merchant-id": merchantId });
  expect(inv.status).toBe(201);
  const b = new Browser(() => node.url);
  const acc = await b.post("/v1/invites/accept", { token: tokenOf(inv.json.items[0].link), name: email.split("@")[0], password: PW });
  expect(acc.status).toBe(200);
  return b;
}

beforeAll(async () => {
  anvil = await startAnvil();
  ({ hub, token } = await deployClearing(anvil));
  const factory = await anvil.deploy(depositFactoryAbi as Abi, depositFactoryBytecode);
  const router = await anvil.deploy(paymentRouterAbi as Abi, paymentRouterBytecode);
  gatewayCfg = {
    seedPayout: PAYOUT.address,
    platformName: "Acme Platform",
    feeRecipient: FEES,
    paymentRouter: router,
    checkoutBaseUrl: DASH,
    depositFactory: factory,
    depositFactoryBlock: 0n,
    forwarderImplementation: null,
    checkoutTtlSec: 1800,
    webhookAllowPrivate: true,
    watchIntervalMs: 2000,
    screenMinPayerNonce: 0,
  };
  const logger = createLogger({ level: "info", sink: (l) => logs.push(l) });
  node = await startNode(testConfig({ rpcUrl: anvil.rpcUrl, hub, token, dbPath: tmp.dbPath, adminToken: ADMIN, gateway: gatewayCfg }), { logger, port: 0, workers: false });
  owner = new Browser(() => node.url);
}, 120_000);

afterAll(async () => {
  await node?.stop();
  anvil?.stop();
  tmp.cleanup();
  tmp2.cleanup();
});

describe("passwords", () => {
  it("hashes with scrypt, verifies in constant time, and asks to rehash weaker parameters", async () => {
    const h = await hashPassword("correct horse battery", 12);
    expect(h).toMatch(/^scrypt\$12\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery", h, 12)).toEqual({ ok: true, rehash: false });
    expect(await verifyPassword("correct horse batterY", h, 12)).toEqual({ ok: false, rehash: false });
    expect(await verifyPassword("correct horse battery", h, 13)).toEqual({ ok: true, rehash: true });
    expect((await verifyPassword("anything", null, 12)).ok).toBe(false);
    expect(h).not.toBe(await hashPassword("correct horse battery", 12));
  });

  it("refuses short, long, common, patterned and email-equal passwords, and nothing else", () => {
    expect(passwordProblem("short")).toBe("too_short");
    expect(passwordProblem("x".repeat(257))).toBe("too_long");
    expect(passwordProblem("password1234")).toBe("common");
    expect(passwordProblem("Password1234!!")).toBe("common");
    expect(passwordProblem("aaaaaaaaaaaaaa")).toBe("common");
    expect(passwordProblem("abcabcabcabc")).toBe("common");
    expect(passwordProblem("123456789012")).toBe("common");
    expect(passwordProblem("priya.sharma@x.io", { email: "priya.sharma@x.io" })).toBe("equals_email");
    expect(passwordProblem("acme platform", { extra: ["Acme Platform"] })).toBe("common");
    expect(passwordProblem("purple-otter-sings-at-dawn")).toBeNull();
    expect(passwordProblem("no composition rules at all")).toBeNull();
  });
});

describe("first-run setup and the recovery key", () => {
  it("prints a one-time setup code and reports setup as needed", async () => {
    expect(setupCodeFromLogs()).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    const info = await owner.get("/v1/setup");
    expect(info.json).toMatchObject({ needed: true, platform_name: "Acme Platform", network: { chain_id: 31337 }, payout_default: PAYOUT.address, fee_wallet: FEES });
    // The code is stored hashed only.
    const code = setupCodeFromLogs()!;
    expect(JSON.stringify(node.services.db.all("SELECT * FROM auth_tokens"))).not.toContain(code.replace(/-/g, ""));
  });

  it("the recovery key works on every route before setup, and every use is audited", async () => {
    const r = await bearer("GET", "/v1/merchants", ADMIN);
    expect(r.status).toBe(200);
    const s = await bearer("GET", "/v1/auth/session", ADMIN);
    expect(s.json).toMatchObject({ actor_type: "recovery_key", user: null });
    const used = node.services.db.all<{ target: string }>("SELECT target FROM audit_events WHERE action = 'recovery_key.used'");
    expect(used.map((u) => u.target)).toContain("GET /v1/merchants");
  });

  it("refuses wrong, expired and weak attempts, then accepts the code (dashes and case ignored)", async () => {
    expect((await owner.post("/v1/setup/check", { code: "AAAA-BBBB-CCCC" })).json.error.code).toBe("SETUP_CODE_INVALID");
    // ADMIN_TOKEN also works as the code.
    expect((await owner.post("/v1/setup/check", { code: ADMIN })).json).toEqual({ ok: true });
    // An expired code answers 410 and a new one is printed.
    const before = setupCodeFromLogs()!;
    node.services.db.run("UPDATE auth_tokens SET expires_unix = ? WHERE kind = 'setup'", nowSec() - 1);
    const expired = await owner.post("/v1/setup/check", { code: before });
    expect(expired.status).toBe(410);
    expect(expired.json.error.code).toBe("SETUP_CODE_EXPIRED");
    const code = setupCodeFromLogs()!;
    expect(code).not.toBe(before);
    expect((await owner.post("/v1/setup/check", { code: code.toLowerCase().replace(/-/g, " ") })).json).toEqual({ ok: true });
    const weak = await owner.post("/v1/setup", { code, name: "Olivia", email: "owner@acme.test", password: "password1234" });
    expect(weak.json.error).toMatchObject({ code: "WEAK_PASSWORD", details: { reason: "common" } });
    // A foreign Origin is refused even before there is a session.
    const evil = new Browser(() => node.url, "https://evil.example");
    expect((await evil.post("/v1/setup", { code, name: "Mallory", email: "m@evil.example", password: PW })).json.error.code).toBe("CSRF_FAILED");
  });

  it("creates the owner, signs them in with an HttpOnly SameSite=Lax cookie, and can never run again", async () => {
    const code = setupCodeFromLogs()!;
    const r = await owner.post("/v1/setup", { code, platform_name: "Acme Pay", name: "Olivia", email: "Owner@Acme.test", password: OWNER_PW });
    expect(r.status).toBe(201);
    const cookie = r.cookies.find((c) => c.startsWith("pm_session="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure|Domain/);
    expect(r.json).toMatchObject({
      actor_type: "user",
      user: { email: "owner@acme.test", platform_role: "owner", email_verified: true, status: "active" },
      platform: { name: "Acme Pay", signup_mode: "off", recovery_key_enabled: false },
    });
    expect(r.json.permissions.platform).toContain("earnings.read");
    expect(r.json.permissions.businesses["*"]).toContain("payout.change");
    expect(typeof r.json.csrf_token).toBe("string");
    expect((await owner.get("/v1/setup")).json).toEqual({ needed: false, signup_mode: "off" });
    expect((await owner.post("/v1/setup", { code, name: "X", email: "x@x.test", password: PW })).json.error.code).toBe("SETUP_DONE");
    expect((await owner.post("/v1/setup/check", { code: ADMIN })).json.error.code).toBe("SETUP_DONE");
    expect(node.services.db.get("SELECT 1 FROM audit_events WHERE action = 'setup.completed'")).toBeTruthy();
  });

  it("refuses the recovery key after setup (break-glass off) but keeps /metrics and public routes", async () => {
    const r = await bearer("GET", "/v1/merchants", ADMIN);
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("RECOVERY_KEY_DISABLED");
    expect((await bearer("GET", "/metrics", ADMIN)).status).toBe(200);
    expect((await bearer("GET", "/v1/info", ADMIN)).status).toBe(200);
  });
});

describe("sign-in, sessions and CSRF", () => {
  it("gives one answer for a wrong password and an unknown email", async () => {
    const b = new Browser(() => node.url);
    const wrong = await b.post("/v1/auth/login", { email: "owner@acme.test", password: "not-the-password-1" });
    const unknown = await b.post("/v1/auth/login", { email: "nobody@acme.test", password: "not-the-password-1" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
    expect(wrong.json.error.code).toBe("INVALID_CREDENTIALS");
    expect(b.cookie).toBeNull();
    expect(node.services.metrics.counter("payminto_auth_failures_total", { reason: "unknown_email" })).toBeGreaterThan(0);
  });

  it("signs in, reads the session, and requires the CSRF header and a known Origin for changes", async () => {
    const b = new Browser(() => node.url);
    const r = await b.post("/v1/auth/login", { email: "OWNER@acme.test", password: OWNER_PW });
    expect(r.status).toBe(200);
    const csrf = b.csrf!;
    expect((await b.get("/v1/auth/session")).json.user.email).toBe("owner@acme.test");
    b.csrf = null;
    expect((await b.patch("/v1/auth/me", { name: "Liv" })).json.error.code).toBe("CSRF_FAILED");
    b.csrf = "wrong";
    expect((await b.patch("/v1/auth/me", { name: "Liv" })).json.error.code).toBe("CSRF_FAILED");
    b.csrf = csrf;
    expect((await b.patch("/v1/auth/me", { name: "Liv" }, { origin: "https://evil.example" })).json.error.code).toBe("CSRF_FAILED");
    expect((await b.patch("/v1/auth/me", { name: "Olivia" })).json.user.name).toBe("Olivia");
    // A request without Origin (server-side fetch) is fine with the header.
    expect((await b.patch("/v1/auth/me", { name: "Olivia" }, { origin: "" })).status).toBe(200);
    // Gateway routes check CSRF too.
    b.csrf = null;
    expect((await b.post("/v1/links", { title: "x", amount: "1000000" })).json.error.code).toBe("CSRF_FAILED");
    b.csrf = csrf;
    // The live event stream takes the session cookie (EventSource sends cookies, not headers).
    const ctl = new AbortController();
    const sse = await fetch(`${node.url}/v1/events`, { headers: { cookie: b.cookie! }, signal: ctl.signal });
    expect(sse.status).toBe(200);
    ctl.abort();
    // Public routes ignore the session cookie, so they need no CSRF header.
    b.csrf = null;
    expect((await b.get("/v1/info")).status).toBe(200);
    b.csrf = csrf;
    expect((await b.post("/v1/auth/logout")).json).toEqual({ ok: true });
    const after = await b.get("/v1/auth/session");
    expect(after.status).toBe(401);
  });

  it("a revoked or unknown cookie is 401 with a reason, and the cookie is cleared", async () => {
    const b = new Browser(() => node.url);
    await b.post("/v1/auth/login", { email: "owner@acme.test", password: OWNER_PW });
    const cookie = b.cookie!;
    await b.post("/v1/auth/logout");
    b.cookie = cookie;
    const r = await b.get("/v1/auth/session");
    expect(r.json.error).toMatchObject({ code: "UNAUTHORIZED", details: { reason: "revoked" } });
    expect(r.cookies.some((c) => /Max-Age=0/.test(c))).toBe(true);
    b.cookie = "pm_session=garbage";
    expect((await b.get("/v1/auth/session")).json.error.details.reason).toBe("missing");
  });

  it("locks an account after 5 failures in 15 minutes, doubling, and the owner can unlock it", async () => {
    await auth().addMember((await owner.get("/v1/merchants")).json.items[0].id, { email: "locky@acme.test", name: "Locky", password: PW }, "viewer", { type: "system", id: null });
    const b = new Browser(() => node.url);
    for (let i = 0; i < 5; i++) expect((await b.post("/v1/auth/login", { email: "locky@acme.test", password: "wrong-password-xx" })).status).toBe(401);
    const locked = await b.post("/v1/auth/login", { email: "locky@acme.test", password: PW });
    expect(locked.status).toBe(401);
    expect(locked.json.error.code).toBe("INVALID_CREDENTIALS");
    const u = auth().userByEmail("locky@acme.test")!;
    expect(u.locked_until_unix! - nowSec()).toBeGreaterThan(14 * 60);
    expect(u.locked_until_unix! - nowSec()).toBeLessThanOrEqual(15 * 60);
    // Second lock doubles: move past the first lock and fail 5 more times.
    const real = auth().clock;
    auth().clock = () => real() + 16 * 60;
    try {
      for (let i = 0; i < 5; i++) await b.post("/v1/auth/login", { email: "locky@acme.test", password: "wrong-password-xx" });
      const u2 = auth().userByEmail("locky@acme.test")!;
      expect(u2.locked_until_unix! - auth().clock()).toBeGreaterThan(29 * 60);
    } finally {
      auth().clock = real;
    }
    expect(node.services.db.get("SELECT 1 FROM audit_events WHERE action = 'auth.locked'")).toBeTruthy();
    expect((await owner.post(`/v1/users/${u.id}/unlock`)).json.locked_until).toBeNull();
    expect((await b.post("/v1/auth/login", { email: "locky@acme.test", password: PW })).status).toBe(200);
  });

  it("expires idle sessions, rotates old ones (the old token works for 60 s), and signs out everywhere", async () => {
    const id = (await owner.get("/v1/merchants")).json.items[0].id;
    await auth().addMember(id, { email: "rota@acme.test", name: "Rota", password: PW }, "staff", { type: "system", id: null });
    const b = new Browser(() => node.url);
    await b.post("/v1/auth/login", { email: "rota@acme.test", password: PW });
    const first = b.cookie!;
    const real = auth().clock;
    try {
      // Business users idle out after 7 days; after 25 h of use the session rotates.
      auth().clock = () => real() + 25 * 3600;
      const r = await b.get("/v1/auth/session");
      expect(r.status).toBe(200);
      expect(b.cookie).not.toBe(first);
      const second = b.cookie!;
      const old = new Browser(() => node.url);
      old.cookie = first;
      expect((await old.get("/v1/auth/session")).status).toBe(200);
      auth().clock = () => real() + 25 * 3600 + 61;
      expect((await old.get("/v1/auth/session")).status).toBe(401);
      b.cookie = second;
      expect((await b.get("/v1/auth/session")).status).toBe(200);
      // Idle expiry: 8 days without a request.
      auth().clock = () => real() + 25 * 3600 + 8 * 86_400;
      expect((await b.get("/v1/auth/session")).json.error.details.reason).toBe("expired");
    } finally {
      auth().clock = real;
    }
    const p1 = new Browser(() => node.url);
    const p2 = new Browser(() => node.url);
    await p1.post("/v1/auth/login", { email: "rota@acme.test", password: PW });
    await p2.post("/v1/auth/login", { email: "rota@acme.test", password: PW });
    expect((await p1.get("/v1/auth/sessions")).json.items.length).toBeGreaterThanOrEqual(2);
    expect((await p1.post("/v1/auth/logout-all")).json.ok).toBe(true);
    expect((await p2.get("/v1/auth/session")).status).toBe(401);
    // Platform roles idle out after 12 h.
    const o = new Browser(() => node.url);
    await o.post("/v1/auth/login", { email: "owner@acme.test", password: OWNER_PW });
    auth().clock = () => real() + 13 * 3600;
    try {
      expect((await o.get("/v1/auth/session")).status).toBe(401);
    } finally {
      auth().clock = real;
    }
  });

  it("needs a password check within 10 minutes for sensitive actions", async () => {
    const real = auth().clock;
    try {
      auth().clock = () => real() + 11 * 60;
      const r = await owner.post("/v1/api-keys", { name: "ci" });
      expect(r.json.error.code).toBe("STEP_UP_REQUIRED");
      expect((await owner.post("/v1/auth/step-up", { password: "wrong-password-xx" })).status).toBe(401);
      const up = await owner.post("/v1/auth/step-up", { password: OWNER_PW });
      expect(up.json.step_up_until).toBeTruthy();
      const ok = await owner.post("/v1/api-keys", { name: "ci" });
      expect(ok.status).toBe(201);
      expect(ok.json.secret).toMatch(/^sk_test_/);
    } finally {
      auth().clock = real;
    }
  });

  it("changes a password: rotates this session, ends the others, and emails a notice", async () => {
    const a1 = new Browser(() => node.url);
    const a2 = new Browser(() => node.url);
    const id = (await owner.get("/v1/merchants")).json.items[0].id;
    await auth().addMember(id, { email: "pw@acme.test", name: "Pw", password: PW }, "viewer", { type: "system", id: null });
    await a1.post("/v1/auth/login", { email: "pw@acme.test", password: PW });
    await a2.post("/v1/auth/login", { email: "pw@acme.test", password: PW });
    const before = a1.cookie;
    expect((await a1.post("/v1/auth/password", { current_password: "wrong-password-xx", new_password: "another-fine-phrase-77" })).status).toBe(401);
    const r = await a1.post("/v1/auth/password", { current_password: PW, new_password: "another-fine-phrase-77" });
    expect(r.status).toBe(200);
    expect(a1.cookie).not.toBe(before);
    expect((await a1.get("/v1/auth/session")).status).toBe(200);
    expect((await a2.get("/v1/auth/session")).status).toBe(401);
    expect(node.services.db.get("SELECT 1 FROM outbox_emails WHERE to_addr = 'pw@acme.test' AND kind = 'password_changed'")).toBeTruthy();
  });
});

describe("invites, roles and isolation", () => {
  let adminA: Browser;
  let staffA: Browser;
  let viewerA: Browser;
  let adminB: Browser;
  let keyA: string;
  let payA: string;
  let payB: string;

  beforeAll(async () => {
    merchantA = (await owner.get("/v1/merchants")).json.items[0].id;
    merchantB = await newBusiness("Beta Goods");
    adminA = await member(owner, merchantA, "admin-a@acme.test", "admin");
    staffA = await member(adminA, merchantA, "staff-a@acme.test", "staff");
    viewerA = await member(adminA, merchantA, "viewer-a@acme.test", "viewer");
    adminB = await member(owner, merchantB, "admin-b@beta.test", "admin");
    keyA = (await adminA.post("/v1/api-keys", { name: "server" })).json.secret;
    payA = (await adminA.post("/v1/payments", { amount: "2500000", description: "Order alpha-1001", reference: "A-1001", customer_email: "alice@example.com" })).json.id;
    payB = (await adminB.post("/v1/payments", { amount: "7000000", description: "Order beta-2002", customer_email: "bob@example.com" })).json.id;
  });

  it("invite links are single use, can be looked up, and expire", async () => {
    const inv = await adminA.post("/v1/invites", { emails: ["new-hire@acme.test"], role: "staff" });
    const tok = tokenOf(inv.json.items[0].link);
    expect(outboxLink("new-hire@acme.test", "invite")).toBe(inv.json.items[0].link);
    expect((await new Browser(() => node.url).post("/v1/invites/lookup", { token: tok })).json).toMatchObject({ email: "new-hire@acme.test", role: "staff", business_name: "Acme Platform", status: "pending", user_exists: false });
    expect((await adminA.get("/v1/invites")).json.items.map((i: { email: string }) => i.email)).toContain("new-hire@acme.test");
    const fresh = new Browser(() => node.url);
    expect((await fresh.post("/v1/invites/accept", { token: tok, name: "New", password: "short" })).json.error.code).toBe("WEAK_PASSWORD");
    expect((await fresh.post("/v1/invites/accept", { token: tok, name: "New", password: PW })).json.memberships[0]).toMatchObject({ merchant_id: merchantA, role: "staff" });
    expect((await new Browser(() => node.url).post("/v1/invites/accept", { token: tok, name: "Again", password: PW })).json.error.code).toBe("TOKEN_USED");
    // Expired.
    const inv2 = await adminA.post("/v1/invites", { emails: ["late@acme.test"], role: "viewer" });
    node.services.db.run("UPDATE auth_tokens SET expires_unix = ? WHERE id = ?", nowSec() - 1, inv2.json.items[0].id);
    expect((await new Browser(() => node.url).post("/v1/invites/accept", { token: tokenOf(inv2.json.items[0].link), name: "L", password: PW })).json.error.code).toBe("TOKEN_EXPIRED");
    // Revoked, and resend replaces the link.
    const inv3 = await adminA.post("/v1/invites", { emails: ["maybe@acme.test"], role: "viewer" });
    const resent = await adminA.post(`/v1/invites/${inv3.json.items[0].id}/resend`);
    expect(resent.json.link).not.toBe(inv3.json.items[0].link);
    expect((await new Browser(() => node.url).post("/v1/invites/accept", { token: tokenOf(inv3.json.items[0].link), name: "M", password: PW })).json.error.code).toBe("TOKEN_USED");
    expect((await adminA.del(`/v1/invites/${resent.json.id}`)).json.revoked).toBe(true);
    expect((await new Browser(() => node.url).post("/v1/invites/accept", { token: tokenOf(resent.json.link), name: "M", password: PW })).json.error.code).toBe("TOKEN_USED");
    // Inviting an existing member is refused per item.
    expect((await adminA.post("/v1/invites", { emails: ["staff-a@acme.test"], role: "viewer" })).json.items[0].error.code).toBe("ALREADY_MEMBER");
  });

  it("an existing user accepts only while signed in as the invited email", async () => {
    const inv = await adminB.post("/v1/invites", { emails: ["staff-a@acme.test"], role: "viewer" });
    const tok = tokenOf(inv.json.items[0].link);
    expect((await new Browser(() => node.url).post("/v1/invites/lookup", { token: tok })).json.user_exists).toBe(true);
    expect((await new Browser(() => node.url).post("/v1/invites/accept", { token: tok })).json.error.code).toBe("SIGN_IN_REQUIRED");
    expect((await viewerA.post("/v1/invites/accept", { token: tok })).json.error.code).toBe("WRONG_ACCOUNT");
    const r = await staffA.post("/v1/invites/accept", { token: tok });
    expect(r.status).toBe(200);
    expect(r.json.memberships.map((m: { merchant_id: string; role: string }) => [m.merchant_id, m.role]).sort()).toEqual([[merchantA, "staff"], [merchantB, "viewer"]].sort());
    // With two businesses and no Merchant-Id the last accepted one is used; Merchant-Id picks either.
    expect((await staffA.get("/v1/merchant")).json.id).toBe(merchantB);
    expect((await staffA.get("/v1/merchant", { "merchant-id": merchantA })).json.id).toBe(merchantA);
  });

  it("enforces the permission matrix per role", async () => {
    const H = { "merchant-id": merchantA };
    const checks: Array<[string, Browser | string, string, string, unknown, number]> = [
      // [label, who, method, path, body, expected status]
      ["viewer reads payments", viewerA, "GET", "/v1/payments", undefined, 200],
      ["viewer cannot create a link", viewerA, "POST", "/v1/links", { title: "x", amount: "1000000" }, 403],
      ["viewer cannot refund", viewerA, "POST", "/v1/refunds", { paymentId: payA, amount: "1" }, 403],
      ["viewer cannot read webhooks", viewerA, "GET", "/v1/webhooks", undefined, 403],
      ["viewer reads blocked wallets", viewerA, "GET", "/v1/screening/deny-list", undefined, 200],
      ["viewer cannot block a wallet", viewerA, "POST", "/v1/screening/deny-list", { address: PAYOUT_B.address }, 403],
      ["viewer cannot read the activity log", viewerA, "GET", "/v1/audit", undefined, 403],
      ["staff creates a link", staffA, "POST", "/v1/links", { title: "Staff link", amount: "1000000" }, 201],
      ["staff cannot invite", staffA, "POST", "/v1/invites", { emails: ["z@z.test"], role: "viewer" }, 403],
      ["staff cannot read API keys", staffA, "GET", "/v1/api-keys", undefined, 403],
      ["staff cannot change methods", staffA, "PUT", `/v1/merchants/${merchantA}/methods`, { methods: [{ method: "x402", enabled: false }] }, 403],
      ["staff reads members", staffA, "GET", "/v1/members", undefined, 200],
      ["admin toggles a method", adminA, "PUT", `/v1/merchants/${merchantA}/methods`, { methods: [{ method: "x402", enabled: true }] }, 200],
      ["admin cannot set method fees", adminA, "PUT", `/v1/merchants/${merchantA}/methods`, { methods: [{ method: "x402", fee_bps: 10 }] }, 403],
      ["admin reads webhooks", adminA, "GET", "/v1/webhooks", undefined, 200],
      ["admin reads the activity log", adminA, "GET", "/v1/audit", undefined, 200],
      ["admin cannot list businesses", adminA, "GET", "/v1/merchants", undefined, 403],
      ["admin cannot read pricing", adminA, "GET", "/v1/fee-plans", undefined, 403],
      ["admin cannot read budgets", adminA, "GET", "/v1/mandates", undefined, 403],
      ["admin cannot run a settlement", adminA, "POST", "/v1/settlements", {}, 403],
      ["admin cannot read the outbox", adminA, "GET", "/v1/platform/outbox", undefined, 403],
      ["admin cannot read platform earnings", adminA, "GET", "/v1/platform/fees", undefined, 403],
      ["api key creates a payment", keyA, "POST", "/v1/payments", { amount: "1000000" }, 201],
      ["api key cannot list members", keyA, "GET", "/v1/members", undefined, 403],
      ["api key cannot create keys", keyA, "POST", "/v1/api-keys", {}, 401],
      ["api key cannot read businesses", keyA, "GET", "/v1/merchants", undefined, 401],
      ["owner reads earnings", owner, "GET", "/v1/platform/fees", undefined, 200],
      ["owner reads budgets", owner, "GET", "/v1/mandates", undefined, 200],
    ];
    for (const [label, who, method, path, b, want] of checks) {
      const r = typeof who === "string" ? await bearer(method, path, who, b) : await who.req(method, path, b, H);
      expect({ label, status: r.status }).toEqual({ label, status: want });
      if (want === 403 && typeof who !== "string") expect(["FORBIDDEN", "OPERATOR_ONLY"]).toContain(r.json.error.code);
    }
  });

  it("platform admins manage businesses but not pricing, earnings, the outbox or payout wallets", async () => {
    const inv = await owner.post("/v1/invites", { emails: ["padmin@acme.test"], role: "platform_admin" });
    expect(inv.status).toBe(201);
    const pa = new Browser(() => node.url);
    const acc = await pa.post("/v1/invites/accept", { token: tokenOf(inv.json.items[0].link), name: "Pat", password: PW });
    expect(acc.json.user.platform_role).toBe("admin");
    expect(acc.json.permissions.businesses["*"]).not.toContain("payout.change");
    expect((await pa.get("/v1/merchants")).status).toBe(200);
    expect((await pa.get("/v1/fee-plans")).status).toBe(200);
    expect((await pa.post("/v1/fee-plans", { name: "Cheap", platform_fee_bps: 10 })).status).toBe(403);
    expect((await pa.get("/v1/platform/fees")).status).toBe(403);
    expect((await pa.get("/v1/platform/outbox")).status).toBe(403);
    expect((await pa.patch("/v1/platform", { name: "Mine" })).status).toBe(403);
    expect((await pa.get("/v1/payments")).json.items.length).toBeGreaterThanOrEqual(2);
    const ts = nowSec();
    const proof = { payout: PAYOUT.address, timestamp: ts, signature: await PAYOUT.signMessage({ message: payoutChangeMessage(merchantB, PAYOUT.address, ts, scope()) }) };
    expect((await pa.post(`/v1/merchants/${merchantB}/payout`, proof)).json.error.code).toBe("FORBIDDEN");
    expect((await owner.get("/v1/platform/team")).json.items.map((t: { email: string }) => t.email)).toEqual(["owner@acme.test", "padmin@acme.test"]);
    const ownerId = auth().userByEmail("owner@acme.test")!.id;
    expect((await owner.patch(`/v1/platform/team/${ownerId}`, { platform_role: null })).json.error.code).toBe("OWNER_PROTECTED");
  });

  it("isolates businesses: other businesses' records are 404 and Merchant-Id cannot cross over", async () => {
    expect((await adminA.get(`/v1/payments/${payB}`)).status).toBe(404);
    expect((await adminB.get(`/v1/payments/${payA}`)).status).toBe(404);
    expect((await bearer("GET", `/v1/payments/${payB}`, keyA)).status).toBe(404);
    const cross = await adminA.get("/v1/payments", { "merchant-id": merchantB });
    expect(cross.status).toBe(404);
    expect(cross.json.error.code).toBe("UNKNOWN_MERCHANT");
    expect((await bearer("GET", "/v1/payments", keyA, undefined, { "merchant-id": merchantB })).json.error.code).toBe("UNKNOWN_MERCHANT");
    expect((await adminA.get("/v1/payments")).json.items.map((p: { id: string }) => p.id)).not.toContain(payB);
    expect((await adminA.get("/v1/members", { "merchant-id": merchantB })).status).toBe(404);
    expect((await adminA.post("/v1/invites", { emails: ["x@x.test"], role: "admin" }, { "merchant-id": merchantB })).status).toBe(404);
    expect((await adminA.get("/v1/audit", { "merchant-id": merchantA })).json.items.every((i: { merchant_id: string }) => i.merchant_id === merchantA)).toBe(true);
    expect((await adminA.get(`/v1/audit?merchant_id=${merchantB}`)).status).toBe(404);
    // The owner sees every business without Merchant-Id, each item carrying merchant_id.
    const all = await owner.get("/v1/payments");
    expect(all.json.items.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([payA, payB]));
    expect((await owner.get(`/v1/payments/${payB}`)).status).toBe(200);
  });

  it("Staff edit only their own links and request refunds that an Admin approves", async () => {
    const mine = (await staffA.post("/v1/links", { title: "Mine", amount: "1000000" }, { "merchant-id": merchantA })).json;
    const theirs = (await adminA.post("/v1/links", { title: "Admin link", amount: "1000000" })).json;
    expect((await staffA.patch(`/v1/links/${mine.id}`, { title: "Mine 2" }, { "merchant-id": merchantA })).json.title).toBe("Mine 2");
    expect((await staffA.patch(`/v1/links/${theirs.id}`, { title: "Nope" }, { "merchant-id": merchantA })).status).toBe(403);
    // A refund request needs a paid payment: credit one directly (the chain path is covered by gateway.test.ts).
    node.services.db.run("UPDATE payments SET status = 'paid', amount_paid = amount, payer = ? WHERE id = ?", PAYOUT_B.address, payA);
    const req = await staffA.post("/v1/refunds", { paymentId: payA, amount: "500000", note: "customer asked by phone" }, { "merchant-id": merchantA });
    expect(req.status).toBe(201);
    expect(req.json).toMatchObject({ approval: "requested", authorization: null, note: "customer asked by phone" });
    expect((await adminA.post(`/v1/refunds/${req.json.id}/submit`, { txHash: `0x${"ab".repeat(32)}` })).json.error.code).toBe("REFUND_APPROVAL_REQUIRED");
    expect((await staffA.post(`/v1/refunds/${req.json.id}/approve`, {}, { "merchant-id": merchantA })).status).toBe(403);
    const ok = await adminA.post(`/v1/refunds/${req.json.id}/approve`);
    expect(ok.json.approval).toBe("approved");
    expect(ok.json.authorization).toBeTruthy();
    expect((await adminA.patch(`/v1/refunds/${req.json.id}`, { note: "approved after call" })).json.note).toBe("approved after call");
    // The internal note never reaches the public checkout.
    expect(JSON.stringify((await new Browser(() => node.url).get(`/v1/checkout/${payA}`)).json)).not.toContain("approved after call");
    const acts = node.services.db.all<{ action: string }>("SELECT action FROM audit_events WHERE target = ?", req.json.id).map((r) => r.action);
    expect(acts).toEqual(["refund.requested", "refund.approved"]);
  });

  it("resolves a record's business on the platform view, so a bare detail URL works without Merchant-Id", async () => {
    node.services.db.run("UPDATE payments SET status = 'paid', amount_paid = amount, payer = ? WHERE id = ?", PAYOUT.address, payB);
    // Another business's Admin cannot refund it: their own business is used, where the payment does not exist.
    expect((await adminA.post("/v1/refunds", { paymentId: payB, amount: "100000" })).status).toBe(404);
    const r = await owner.post("/v1/refunds", { paymentId: payB, amount: "100000" });
    expect(r.status).toBe(201);
    expect(r.json.payment_id).toBe(payB);
    expect((await owner.get(`/v1/refunds/${r.json.id}`)).status).toBe(200);
    expect((await owner.post(`/v1/refunds/${r.json.id}/cancel`)).status).toBe(200);
    expect((await owner.get("/v1/merchant", { "merchant-id": merchantB })).json.id).toBe(merchantB);
    node.services.db.run("UPDATE payments SET status = 'open', amount_paid = '0', payer = NULL WHERE id = ?", payB);
  });

  it("guards the last Admin and rotates the sessions of a member whose role changes", async () => {
    const adminAId = auth().userByEmail("admin-a@acme.test")!.id;
    expect((await adminA.patch(`/v1/members/${adminAId}`, { role: "staff" })).json.error.code).toBe("LAST_ADMIN");
    expect((await adminA.del(`/v1/members/${adminAId}`)).json.error.code).toBe("LAST_ADMIN");
    const viewerId = auth().userByEmail("viewer-a@acme.test")!.id;
    const before = viewerA.cookie;
    expect((await adminA.patch(`/v1/members/${viewerId}`, { role: "staff" })).json.role).toBe("staff");
    const s = await viewerA.get("/v1/auth/session");
    expect(viewerA.cookie).not.toBe(before);
    expect(s.json.memberships[0].role).toBe("staff");
    expect((await adminA.patch(`/v1/members/${viewerId}`, { role: "viewer" })).json.role).toBe("viewer");
    await viewerA.get("/v1/auth/session");
  });

  it("searches by id, email, reference, address and text, scoped to what the actor sees", async () => {
    const byId = await adminA.get(`/v1/search?q=${payA}`);
    expect(byId.json.detected).toBe("id");
    expect(byId.json.groups[0]).toMatchObject({ type: "payment", items: [{ id: payA, href: `/payments/${payA}`, merchant_id: merchantA }] });
    // Another business's id finds nothing.
    expect((await adminA.get(`/v1/search?q=${payB}`)).json.groups).toEqual([]);
    expect((await adminB.get(`/v1/search?q=${payB}`)).json.groups[0].items[0].id).toBe(payB);
    const byEmail = await adminA.get("/v1/search?q=alice@example.com");
    expect(byEmail.json.detected).toBe("email");
    expect(byEmail.json.groups.map((g: { type: string }) => g.type)).toEqual(expect.arrayContaining(["payment", "customer"]));
    expect((await adminA.get("/v1/search?q=bob@example.com")).json.groups).toEqual([]);
    const text = await adminA.get("/v1/search?q=alph");
    expect(text.json.detected).toBe("text");
    expect(text.json.groups.find((g: { type: string }) => g.type === "payment").items[0].id).toBe(payA);
    const ref = await adminA.get("/v1/search?q=A-1001&types=payment");
    expect(ref.json.groups[0].items[0].matched.field).toBe("reference");
    const dep = (await adminA.get(`/v1/payments/${payA}`)).json.deposit_address as string;
    const byAddr = await adminA.get(`/v1/search?q=${dep.toLowerCase()}`);
    expect(byAddr.json.detected).toBe("address");
    expect(byAddr.json.groups[0].items[0]).toMatchObject({ id: payA, matched: { field: "deposit_address" } });
    // A transaction hash on a credit.
    const tx = `0x${"cd".repeat(32)}`;
    node.services.db.run(
      "INSERT INTO payment_credits (payment_id, method, payer, amount, tx_hash, log_index, status, created_at) VALUES (?, 'deposit', ?, '1', ?, 0, 'confirmed', ?)",
      payA,
      PAYOUT_B.address,
      tx,
      new Date().toISOString(),
    );
    expect((await adminA.get(`/v1/search?q=${tx.toUpperCase().replace("0X", "0x")}`)).json.groups[0].items[0]).toMatchObject({ id: payA, matched: { field: "tx_hash" } });
    expect((await adminB.get(`/v1/search?q=${tx}`)).json.groups).toEqual([]);
    // Amount: 2.5 USDC.
    expect((await adminA.get("/v1/search?q=2.5&types=payment")).json.groups[0].items[0].id).toBe(payA);
    // Businesses only for platform roles.
    expect((await adminA.get("/v1/search?q=Beta")).json.groups.find((g: { type: string }) => g.type === "business")).toBeUndefined();
    expect((await owner.get("/v1/search?q=Beta")).json.groups.find((g: { type: string }) => g.type === "business").items[0].id).toBe(merchantB);
    expect((await owner.get(`/v1/search?q=${payB}`)).json.groups[0].items[0].subtitle).toContain("Beta Goods");
    // Short queries return nothing; API keys search their business.
    expect((await adminA.get("/v1/search?q=a")).json.groups).toEqual([]);
    expect((await bearer("GET", `/v1/search?q=${payA}`, keyA)).json.groups[0].items[0].id).toBe(payA);
    expect((await bearer("GET", `/v1/search?q=${payB}`, keyA)).json.groups).toEqual([]);
    expect((await adminA.get(`/v1/search?q=x&merchant_id=${merchantB}`)).status).toBe(404);
    // Recent items, per user.
    await adminA.post("/v1/search/recent", { type: "payment", id: payA, title: "Order alpha-1001", href: `/payments/${payA}` });
    expect((await adminA.get("/v1/search/recent")).json.items[0]).toMatchObject({ id: payA });
    expect((await adminB.get("/v1/search/recent")).json.items).toEqual([]);
  });

  it("derives customers from payments, with totals, per business", async () => {
    await adminA.post("/v1/payments", { amount: "1000000", customer_email: "ALICE@example.com", customer_name: "Alice" });
    const list = await adminA.get("/v1/customers");
    const alice = list.json.items.find((c: { email: string }) => c.email?.toLowerCase() === "alice@example.com");
    expect(alice).toMatchObject({ merchant_id: merchantA, payments: 2, paid_payments: 1, total_paid: "2500000", name: "Alice" });
    expect(list.json.items.some((c: { email: string }) => c.email === "bob@example.com")).toBe(false);
    const detail = await adminA.get(`/v1/customers/${alice.id}`);
    expect(detail.json.recent_payments.map((p: { id: string }) => p.id)).toContain(payA);
    expect((await adminB.get(`/v1/customers/${alice.id}`)).status).toBe(404);
    expect((await adminA.get("/v1/customers?q=ali")).json.items.length).toBe(1);
    expect((await owner.get("/v1/customers")).json.items.map((c: { merchant_id: string }) => c.merchant_id)).toEqual(expect.arrayContaining([merchantA, merchantB]));
  });

  it("counts on the payments list respect the filters (carry-over 1)", async () => {
    const link = (await adminA.post("/v1/links", { title: "Counted", amount: "1000000" })).json;
    const one = await new Browser(() => node.url).post(`/v1/links/public/${link.slug}/payments`, {});
    expect(one.status).toBe(201);
    const filtered = await adminA.get(`/v1/payments?link_id=${link.id}`);
    expect(filtered.json.counts.all).toBe(1);
    expect(filtered.json.counts.open).toBe(1);
    expect((await adminA.get("/v1/payments")).json.counts.all).toBeGreaterThan(1);
    expect((await adminA.get(`/v1/payments?link_id=${link.id}&status=paid`)).json.counts.all).toBe(1);
  });
});

describe("password reset, sign-up and the outbox", () => {
  it("resets a password with a single-use 30-minute link and ends every session", async () => {
    const b = new Browser(() => node.url);
    await b.post("/v1/auth/login", { email: "admin-b@beta.test", password: PW });
    const anon = new Browser(() => node.url);
    expect((await anon.post("/v1/auth/forgot", { email: "nobody@nowhere.test" })).status).toBe(202);
    expect((await anon.post("/v1/auth/forgot", { email: "admin-b@beta.test" })).status).toBe(202);
    const link = outboxLink("admin-b@beta.test", "reset_password")!;
    expect(link).toMatch(new RegExp(`^${DASH}/reset/`));
    expect((await anon.post("/v1/auth/reset/check", { token: tokenOf(link) })).json).toEqual({ ok: true, email: "admin-b@beta.test" });
    expect((await anon.post("/v1/auth/reset", { token: tokenOf(link), password: "short" })).json.error.code).toBe("WEAK_PASSWORD");
    expect((await anon.post("/v1/auth/reset", { token: tokenOf(link), password: "brand-new-passphrase-5" })).json).toEqual({ ok: true });
    expect((await b.get("/v1/auth/session")).status).toBe(401);
    expect((await anon.post("/v1/auth/reset", { token: tokenOf(link), password: "brand-new-passphrase-6" })).json.error.code).toBe("TOKEN_USED");
    expect((await anon.post("/v1/auth/login", { email: "admin-b@beta.test", password: "brand-new-passphrase-5" })).status).toBe(200);
    await anon.post("/v1/auth/forgot", { email: "admin-b@beta.test" });
    const link2 = outboxLink("admin-b@beta.test", "reset_password")!;
    const real = auth().clock;
    auth().clock = () => real() + 31 * 60;
    try {
      expect((await anon.post("/v1/auth/reset", { token: tokenOf(link2), password: "brand-new-passphrase-7" })).json.error.code).toBe("TOKEN_EXPIRED");
    } finally {
      auth().clock = real;
    }
  });

  it("the reset-owner CLI prints a one-time link for the owner only", () => {
    const script = fileURLToPath(new URL("../scripts/account.ts", import.meta.url));
    const out = execFileSync(process.execPath, [script, "reset-owner", "--email", "owner@acme.test", "--db", tmp.dbPath], { env: { ...process.env, PUBLIC_DASHBOARD_URL: DASH }, encoding: "utf8" });
    const link = /(http\S+\/reset\/\S+)/.exec(out)![1]!;
    expect(auth().checkReset(tokenOf(link)).email).toBe("owner@acme.test");
    expect(() => execFileSync(process.execPath, [script, "reset-owner", "--email", "admin-a@acme.test", "--db", tmp.dbPath], { stdio: "pipe" })).toThrow();
  });

  it("signs up with approval: verify, wait, approve; the new business needs a payout wallet before payments", async () => {
    const anon = new Browser(() => node.url);
    const off = await anon.post("/v1/auth/signup", { email: "founder@gamma.test", password: PW, name: "Gia", business_name: "Gamma Labs" });
    expect(off.json.error.code).toBe("SIGNUP_DISABLED");
    expect((await owner.patch("/v1/platform", { signup_mode: "approval" })).json.signup_mode).toBe("approval");
    expect((await anon.post("/v1/auth/signup", { email: "founder@gamma.test", password: PW, name: "Gia", business_name: "Gamma Labs" })).status).toBe(202);
    // A taken email answers the same, and that inbox learns it already has an account.
    expect((await anon.post("/v1/auth/signup", { email: "staff-a@acme.test", password: PW, name: "X", business_name: "X" })).status).toBe(202);
    expect(outboxLink("staff-a@acme.test", "account_exists")).toBeNull();
    expect(node.services.db.get("SELECT 1 FROM outbox_emails WHERE to_addr = 'staff-a@acme.test' AND kind = 'account_exists'")).toBeTruthy();
    expect((await owner.get("/v1/platform/signup-requests")).json.items).toEqual([]);
    const f = new Browser(() => node.url);
    expect((await f.post("/v1/auth/login", { email: "founder@gamma.test", password: PW })).json).toMatchObject({ user: { status: "pending", email_verified: false }, signup_request: { status: "unverified" } });
    expect((await f.get("/v1/payments")).json.error.code).toBe("ACCOUNT_PENDING");
    expect((await anon.post("/v1/auth/verify", { token: tokenOf(outboxLink("founder@gamma.test", "verify_email")) })).json).toMatchObject({ ok: true, status: "pending" });
    const reqs = await owner.get("/v1/platform/signup-requests");
    expect(reqs.json.counts.pending).toBe(1);
    const id = reqs.json.items[0].id;
    const approved = await owner.post(`/v1/platform/signup-requests/${id}/approve`);
    expect(approved.json.status).toBe("approved");
    const s = await f.get("/v1/auth/session");
    expect(s.json.user.status).toBe("active");
    expect(s.json.memberships[0]).toMatchObject({ business_name: "Gamma Labs", role: "admin" });
    expect((await f.get("/v1/merchant")).json.payout_set).toBe(false);
    expect((await f.post("/v1/payments", { amount: "1000000" })).json.error.code).toBe("PAYOUT_REQUIRED");
    // The Admin proves a payout wallet, then payments work.
    const mid = s.json.memberships[0].merchant_id;
    const ts = nowSec();
    const proof = { payout: PAYOUT_B.address, timestamp: ts, signature: await PAYOUT_B.signMessage({ message: payoutChangeMessage(mid, PAYOUT_B.address, ts, scope()) }) };
    expect((await f.post(`/v1/merchants/${mid}/payout`, proof)).json.payout_set).toBe(true);
    expect((await f.post("/v1/payments", { amount: "1000000" })).status).toBe(201);
    // Decline path.
    await anon.post("/v1/auth/signup", { email: "nope@delta.test", password: PW, name: "D", business_name: "Delta" });
    await anon.post("/v1/auth/verify", { token: tokenOf(outboxLink("nope@delta.test", "verify_email")) });
    const pending = (await owner.get("/v1/platform/signup-requests")).json.items[0];
    expect((await owner.post(`/v1/platform/signup-requests/${pending.id}/decline`, { reason: "Not a fit" })).json).toMatchObject({ status: "declined", reason: "Not a fit" });
    await owner.patch("/v1/platform", { signup_mode: "off" });
  });

  it("shows the outbox to the owner only and records every view", async () => {
    const before = node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'outbox.viewed'")!.n;
    const r = await owner.get("/v1/platform/outbox");
    expect(r.json.smtp_configured).toBe(false);
    expect(r.json.notice).toMatch(/activity log/);
    expect(r.json.items.length).toBeGreaterThan(0);
    expect(node.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'outbox.viewed'")!.n).toBe(before + 1);
    expect(logs.some((l) => l.includes("[email] to=founder@gamma.test") && l.includes("/verify/"))).toBe(true);
    expect((await owner.post("/v1/platform/email/test")).json).toEqual({ ok: true, delivered: "outbox" });
  });

  it("serves the activity log with filters, plain sentences and CSV", async () => {
    const all = await owner.get("/v1/audit?action=auth.&limit=5");
    expect(all.json.items.length).toBe(5);
    expect(all.json.items.every((i: { action: string }) => i.action.startsWith("auth."))).toBe(true);
    expect(all.json.next_cursor).toBeTruthy();
    const payout = await owner.get("/v1/audit?action=payout.changed");
    expect(payout.json.items[0].summary).toMatch(/changed the payout wallet to 0x/);
    expect(payout.json.items[0].actor).toMatchObject({ type: "user", email: "founder@gamma.test" });
    const csv = await owner.get("/v1/audit?format=csv&action=invite.sent");
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(String(csv.json).split("\r\n")[0]).toBe("id,at,actor_type,actor_id,actor_email,merchant_id,action,target,summary,ip,meta");
    // Append-only.
    expect(() => node.services.db.run("UPDATE audit_events SET action = 'x'")).toThrow(/append-only/);
    expect(() => node.services.db.run("DELETE FROM audit_events")).toThrow(/one year/);
  });
});

describe("carry-over API changes", () => {
  it("link expiry, fee plan merchant_count, platform name, rpc_url, screening copy and delivery schedule", async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const link = await owner.post("/v1/links", { title: "Expiring", amount: "1000000", expires_at: at }, { "merchant-id": merchantA });
    expect(link.json).toMatchObject({ expires_at: at, expired: false });
    expect((await owner.post("/v1/links", { title: "Past", amount: "1", expires_at: new Date(Date.now() - 1000).toISOString() }, { "merchant-id": merchantA })).status).toBe(400);
    node.services.db.run("UPDATE payment_links SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), link.json.id);
    const pay = await new Browser(() => node.url).post(`/v1/links/public/${link.json.slug}/payments`, {});
    expect(pay.json.error.code).toBe("LINK_EXPIRED");
    expect((await new Browser(() => node.url).get(`/v1/links/public/${link.json.slug}`)).json.active).toBe(false);
    const cleared = await owner.patch(`/v1/links/${link.json.id}`, { expires_at: null }, { "merchant-id": merchantA });
    expect(cleared.json.expires_at).toBeNull();

    // The public link shows the customer-borne fee per method, and a quote for a fixed amount; no platform economics.
    await owner.req("PUT", `/v1/merchants/${merchantA}/methods`, { methods: [{ method: "deposit", fee_fixed: "50000", bearer: "customer" }, { method: "wallet", fee_bps: 30, bearer: "merchant" }] });
    const pub = (await new Browser(() => node.url).get(`/v1/links/public/${cleared.json.slug}`)).json;
    const dep = pub.methods.find((m: { method: string }) => m.method === "deposit");
    expect(dep).toMatchObject({ enabled: true, surcharge_bps: 0, surcharge_fixed: "50000", quote: { amount: "1000000", surcharge: "50000", amount_due: "1050000" } });
    expect(pub.methods.find((m: { method: string }) => m.method === "wallet")).toMatchObject({ surcharge_bps: 0, surcharge_fixed: "0", quote: { amount_due: "1000000" } });
    expect(JSON.stringify(pub)).not.toMatch(/platform_fee|net_amount|fee_recipient/);

    const plans = (await owner.get("/v1/fee-plans")).json.items as Array<{ merchant_count: number }>;
    expect(plans.reduce((n, p) => n + p.merchant_count, 0)).toBe((await owner.get("/v1/merchants")).json.items.length);

    expect((await owner.patch("/v1/platform", { name: "Acme Payments" })).json.name).toBe("Acme Payments");
    expect((await owner.get("/v1/auth/session")).json.platform.name).toBe("Acme Payments");

    const info = (await owner.get("/v1/info")).json;
    expect(info.network.rpc_url).toBe(anvil.rpcUrl);

    await owner.post("/v1/screening/deny-list", { address: PAYOUT_B.address }, { "merchant-id": merchantA });
    const view = await new Browser(() => node.url).get(`/v1/payments`);
    expect(view.status).toBe(401);
    await expect(node.services.gateway!.screening.check({ merchantId: merchantA, stage: "authorize", payout: PAYOUT.address, payer: PAYOUT_B.address })).rejects.toThrow();
    const dec = (await owner.get("/v1/screening/decisions", { "merchant-id": merchantA })).json.items[0];
    expect(dec.message).toBe("This wallet is on your blocked list");

    const wh = await owner.post("/v1/webhooks", { url: "http://127.0.0.1:9/hook", events: ["*"] }, { "merchant-id": merchantA });
    expect(wh.status).toBe(201);
    await owner.post("/v1/payments", { amount: "1000000" }, { "merchant-id": merchantA });
    const deliveries = (await owner.get(`/v1/webhooks/${wh.json.id}/deliveries`, { "merchant-id": merchantA })).json.items;
    const pending = deliveries.find((d: { status: string }) => d.status === "pending");
    expect(pending.next_attempt_at).toBeTruthy();
    expect(pending.scheduled_at).toBe(pending.next_attempt_at);
  });
});

describe("auth rate limits and break-glass", () => {
  let n2: ClearingNode;
  afterAll(async () => n2?.stop());

  it("limits auth requests per IP and accepts the recovery key after setup with break-glass, audited", async () => {
    n2 = await startNode(
      testConfig({
        rpcUrl: anvil.rpcUrl,
        hub,
        token,
        dbPath: tmp2.dbPath,
        adminToken: ADMIN,
        gateway: gatewayCfg,
        auth: { scryptLogN: 12, rateLimitPerMin: 3, breakGlass: true, dashboardUrl: "https://pay.example.com" },
      }),
      { logger: createLogger({ sink: () => {} }), port: 0, workers: false },
    );
    const b = new Browser(() => n2.url, "https://pay.example.com");
    const setup = await b.post("/v1/setup", { code: ADMIN, name: "O", email: "o@example.com", password: OWNER_PW });
    expect(setup.status).toBe(201);
    // https dashboards get the __Host- cookie with Secure.
    const ck = setup.cookies.find((c) => c.startsWith("__Host-pm_session="))!;
    expect(ck).toMatch(/Secure/);
    expect(setup.json.platform.recovery_key_enabled).toBe(true);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await b.post("/v1/auth/login", { email: "o@example.com", password: "wrong-password-xx" })).status);
    expect(codes).toEqual([401, 401, 401, 429]);
    const r = await fetch(`${n2.url}/v1/merchants`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(r.status).toBe(200);
    expect(n2.services.db.get("SELECT 1 FROM audit_events WHERE action = 'recovery_key.used' AND meta_json LIKE '%\"bootstrap\":false%'")).toBeTruthy();
  });
});

describe("SMTP", () => {
  let srv: NetServer;
  afterAll(() => srv?.close());

  it("sends through a plain SMTP server with AUTH PLAIN on localhost", async () => {
    const seen: string[] = [];
    srv = createNetServer((sock) => {
      let data = false;
      let buf = "";
      sock.write("220 test ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          seen.push(line);
          if (data) {
            if (line === ".") {
              data = false;
              sock.write("250 queued\r\n");
            }
            continue;
          }
          if (/^EHLO/.test(line)) sock.write("250-test\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (/^AUTH PLAIN/.test(line)) sock.write("235 ok\r\n");
          else if (/^(MAIL|RCPT)/.test(line)) sock.write("250 ok\r\n");
          else if (line === "DATA") {
            data = true;
            sock.write("354 go\r\n");
          } else if (line === "QUIT") sock.end("221 bye\r\n");
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    await sendSmtp({ host: "127.0.0.1", port, secure: false, user: "u", pass: "p", from: "Payminto <no-reply@acme.test>" }, { to: "a@b.test", subject: "Hi", text: "line one\n.line two", kind: "test" });
    expect(seen).toContain(`AUTH PLAIN ${Buffer.from("\0u\0p").toString("base64")}`);
    expect(seen).toContain("MAIL FROM:<no-reply@acme.test>");
    expect(seen).toContain("RCPT TO:<a@b.test>");
    expect(seen).toContain("..line two");
    expect(seen).toContain("Subject: Hi");
  });
});
