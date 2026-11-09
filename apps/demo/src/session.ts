import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEMO_OWNER_EMAIL = "owner@demo.local";

export type DemoLogin = { email: string; password: string; name: string; role: string };

/** A password that passes the node's policy and is easy to copy: 24 base64url characters. */
export function generatePassword(): string {
  return `pm-${randomBytes(18).toString("base64url")}`;
}

/** Writes the demo logins next to the demo database (owner-only file permissions); returns the path. */
export function writeLogins(runDir: string, dashboardUrl: string, logins: DemoLogin[]): string {
  const file = join(runDir, "dashboard-logins.json");
  writeFileSync(file, JSON.stringify({ dashboard: `${dashboardUrl}/login`, note: "Local demo accounts; this file lives in the disposable demo run directory.", logins }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Signs in to the node like the dashboard does (session cookie plus the X-Payminto-CSRF header and the dashboard
 * Origin) and exposes a `fetch` that every SDK client can use instead of the recovery key. It re-reads the session on
 * CSRF_FAILED (the token changes when the session rotates), confirms the password on STEP_UP_REQUIRED, and signs in
 * again on 401, each at most once per request.
 */
export class DashboardSession {
  readonly #nodeUrl: string;
  readonly #origin: string;
  readonly #email: string;
  readonly #password: string;
  #cookie: string | null = null;
  #csrf: string | null = null;

  constructor(o: { nodeUrl: string; origin: string; email: string; password: string }) {
    this.#nodeUrl = o.nodeUrl.replace(/\/+$/, "");
    this.#origin = o.origin;
    this.#email = o.email;
    this.#password = o.password;
  }

  #absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(";")[0]!;
      const i = kv.indexOf("=");
      const name = kv.slice(0, i);
      if (name === "pm_session" || name === "__Host-pm_session") this.#cookie = kv.slice(i + 1) ? kv : null;
    }
  }

  async #raw(path: string, method: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json", origin: this.#origin };
    if (this.#cookie) headers.cookie = this.#cookie;
    if (this.#csrf && MUTATING.has(method)) headers["x-payminto-csrf"] = this.#csrf;
    const res = await globalThis.fetch(`${this.#nodeUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    this.#absorb(res);
    return res;
  }

  async login(): Promise<void> {
    const res = await this.#raw("/v1/auth/login", "POST", { email: this.#email, password: this.#password });
    const json = (await res.json()) as { csrf_token?: string; error?: { code: string; message: string } };
    if (!res.ok || !json.csrf_token) throw new Error(`demo sign-in failed: ${json.error?.code ?? res.status} ${json.error?.message ?? ""}`);
    this.#csrf = json.csrf_token;
  }

  async #refresh(): Promise<void> {
    const res = await this.#raw("/v1/auth/session", "GET");
    if (!res.ok) return this.login();
    this.#csrf = ((await res.json()) as { csrf_token: string }).csrf_token;
  }

  async #stepUp(): Promise<void> {
    const res = await this.#raw("/v1/auth/step-up", "POST", { password: this.#password });
    if (!res.ok) throw new Error(`demo step-up failed: HTTP ${res.status}`);
  }

  /** A fetch that carries this session instead of an Authorization header. */
  readonly fetch: typeof fetch = async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const send = () => {
      const headers = new Headers(init.headers);
      headers.delete("authorization");
      headers.set("origin", this.#origin);
      if (this.#cookie) headers.set("cookie", this.#cookie);
      if (this.#csrf && MUTATING.has(method)) headers.set("x-payminto-csrf", this.#csrf);
      return globalThis.fetch(input, { ...init, headers }).then((res) => (this.#absorb(res), res));
    };
    if (!this.#cookie) await this.login();
    let res = await send();
    for (let retry = 0; retry < 2 && (res.status === 401 || res.status === 403); retry++) {
      const code = ((await res.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      if (code === "UNAUTHORIZED") await this.login();
      else if (code === "CSRF_FAILED") await this.#refresh();
      else if (code === "STEP_UP_REQUIRED") await this.#stepUp();
      else break;
      res = await send();
    }
    return res;
  };
}

/**
 * One Admin per demo business (PRODUCT.md 4.12): the owner invites through the API and the invite is accepted the way
 * the invite page does it, so the staged walkthrough can sign in as the business too. The login joins the saved file.
 */
export async function addBusinessAdmin(
  stack: { nodeUrl: string; session: DashboardSession; runDir: string; logins: { file: string; dashboardUrl: string; items: DemoLogin[] } },
  merchantId: string,
  email: string,
  name: string,
): Promise<DemoLogin> {
  const inv = await stack.session.fetch(`${stack.nodeUrl}/v1/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", "merchant-id": merchantId },
    body: JSON.stringify({ emails: [email], role: "admin" }),
  });
  const invJson = (await inv.json()) as { items?: Array<{ link?: string; error?: { code: string } }> };
  const link = invJson.items?.[0]?.link;
  if (!inv.ok || !link) throw new Error(`invite for ${email} failed: HTTP ${inv.status} ${JSON.stringify(invJson)}`);
  const login: DemoLogin = { email, password: generatePassword(), name, role: "Business admin" };
  const acc = await globalThis.fetch(`${stack.nodeUrl}/v1/invites/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: stack.logins.dashboardUrl },
    body: JSON.stringify({ token: link.split("/").pop(), name, password: login.password }),
  });
  if (!acc.ok) throw new Error(`accepting the invite for ${email} failed: HTTP ${acc.status} ${await acc.text()}`);
  stack.logins.items.push(login);
  writeLogins(stack.runDir, stack.logins.dashboardUrl, stack.logins.items);
  return login;
}
