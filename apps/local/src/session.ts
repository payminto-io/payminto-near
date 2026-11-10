/**
 * A person's session against the node's HTTP API, as the dashboard holds one: a cookie from first-run setup or sign-in,
 * the CSRF token from GET /v1/auth/session on every write, and the dashboard's Origin. Nothing here uses the recovery
 * key, so setup and the scripted check take exactly the routes and the checks a browser takes.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(method: string, path: string, status: number, body: unknown) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    super(`${method} ${path} answered ${status}${e?.code ? ` ${e.code}` : ""}${e?.message ? `: ${e.message}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.code = e?.code ?? "HTTP_ERROR";
    this.body = body;
  }
}

export type SessionOptions = {
  /** Where requests go: the node itself, or the dashboard's own `/api` path in front of it. */
  baseUrl: string;
  /** Sent as Origin, as a browser on the dashboard would. */
  origin: string;
};

export class NodeSession {
  readonly baseUrl: string;
  readonly origin: string;
  #cookies = new Map<string, string>();
  #csrf: string | null = null;
  #password: string | null = null;

  constructor(o: SessionOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.origin = o.origin;
  }

  /** A `fetch` that carries this session, for SDK clients that take one (OwnerClient). */
  readonly fetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", this.origin);
    const cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.set("cookie", cookie);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && this.#csrf) headers.set("x-payminto-csrf", this.#csrf);
    const res = await fetch(input, { ...init, headers, redirect: "manual" });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(line)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return res;
  };

  async request<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const send = () =>
      this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await send();
    let parsed = await read(res);
    // Sensitive actions ask the person to confirm their password again; a person types it, and so does this session.
    if (res.status === 403 && (parsed as { error?: { code?: string } } | null)?.error?.code === "STEP_UP_REQUIRED" && this.#password) {
      await this.request("POST", "/v1/auth/step-up", { password: this.#password });
      res = await send();
      parsed = await read(res);
    }
    if (!res.ok) throw new HttpError(method, path, res.status, parsed);
    return parsed as T;
  }

  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, undefined, headers);
  }
  post<T = unknown>(path: string, body: unknown = {}, headers?: Record<string, string>): Promise<T> {
    return this.request<T>("POST", path, body, headers);
  }

  /** First-run setup: creates the platform owner and signs in as them. */
  async setup(a: { code: string; name: string; email: string; password: string; platformName: string }): Promise<void> {
    await this.request("POST", "/v1/setup", { code: a.code, name: a.name, email: a.email, password: a.password, platform_name: a.platformName });
    this.#password = a.password;
    await this.#readCsrf();
  }

  async login(email: string, password: string): Promise<void> {
    await this.request("POST", "/v1/auth/login", { email, password });
    this.#password = password;
    await this.#readCsrf();
  }

  async #readCsrf(): Promise<void> {
    const s = await this.get<{ csrf_token?: string }>("/v1/auth/session");
    if (!s.csrf_token) throw new Error("the session carries no csrf_token");
    this.#csrf = s.csrf_token;
  }
}

async function read(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
