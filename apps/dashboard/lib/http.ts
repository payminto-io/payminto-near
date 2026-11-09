/**
 * JSON over HTTP to the Payminto server, shared by the console client (session cookie through /api, or the recovery
 * key) and the public checkout client (no credential).
 * Every body is parsed with a zod schema at this boundary.
 */
import type { z } from "zod";
import { apiErrorSchema } from "./schemas";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type RequestOptions = RequestInit & { token?: string | null; idempotencyKey?: string };

/**
 * Same-origin calls (the dashboard's own `/api` path, PRODUCT.md section 10) ride the session cookie. They carry the
 * CSRF value on mutating requests and recover once from a stale CSRF value or a step-up prompt. Calls to an absolute
 * node URL (the public checkout) never take part in this.
 */
type SessionHooks = {
  csrf: () => string | null;
  /** Re-reads the session after 403 CSRF_FAILED; resolves the new CSRF value. */
  refreshCsrf: () => Promise<string | null>;
  /** Asks for the password after 403 STEP_UP_REQUIRED; resolves true once the server accepted it. */
  stepUp: () => Promise<boolean>;
  /** 401 UNAUTHORIZED on a signed-in call: the session ended (`reason` from the server, e.g. "expired"). */
  unauthorized: (reason: string | null) => void;
};
let hooks: SessionHooks | null = null;

export function setSessionHooks(h: SessionHooks | null): void {
  hooks = h;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Routes that answer 401 as a normal outcome rather than an ended session. */
const PRE_SESSION = /^\/v1\/(auth\/(session|login|signup|forgot|reset|verify|step-up)|setup|invites\/(lookup|accept))/;

export function isSameOrigin(nodeUrl: string): boolean {
  return nodeUrl.startsWith("/");
}

export async function requestJson<T>(nodeUrl: string, path: string, schema: z.ZodType<T>, init: RequestOptions = {}, okStatuses: number[] = []): Promise<T> {
  return requestOnce(nodeUrl, path, schema, init, okStatuses, { csrfRetried: false, stepUpRetried: false });
}

async function requestOnce<T>(
  nodeUrl: string,
  path: string,
  schema: z.ZodType<T>,
  init: RequestOptions,
  okStatuses: number[],
  state: { csrfRetried: boolean; stepUpRetried: boolean },
): Promise<T> {
  const { token, idempotencyKey, ...rest } = init;
  const sameOrigin = isSameOrigin(nodeUrl);
  const method = (rest.method ?? "GET").toUpperCase();
  const csrf = sameOrigin && !token && MUTATING.has(method) ? hooks?.csrf() ?? null : null;
  let res: Response;
  try {
    res = await fetch(`${nodeUrl}${path}`, {
      ...rest,
      headers: {
        Accept: "application/json",
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...(csrf ? { "X-Payminto-CSRF": csrf } : {}),
        ...rest.headers,
      },
      ...(sameOrigin ? { credentials: "same-origin" as const } : {}),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "NODE_UNREACHABLE", sameOrigin ? "Cannot reach the Payminto server. Check that it is running." : `Cannot reach the Payminto server at ${nodeUrl}. Check that it is running and that CORS allows this origin.`);
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (sameOrigin && res.status >= 500) throw new ApiError(res.status, "NODE_UNREACHABLE", "Cannot reach the Payminto server. Check that it is running.");
      throw new ApiError(res.status, "BAD_RESPONSE", `The server returned a non-JSON response for ${path}.`);
    }
  }
  if (!res.ok && !okStatuses.includes(res.status)) {
    const err = apiErrorSchema.safeParse(json);
    if (err.success) {
      const { code, message, details } = err.data.error;
      if (sameOrigin && hooks && !token) {
        if (res.status === 403 && code === "CSRF_FAILED" && !state.csrfRetried) {
          await hooks.refreshCsrf();
          return requestOnce(nodeUrl, path, schema, init, okStatuses, { ...state, csrfRetried: true });
        }
        if (res.status === 403 && code === "STEP_UP_REQUIRED" && !state.stepUpRetried) {
          if (await hooks.stepUp()) return requestOnce(nodeUrl, path, schema, init, okStatuses, { ...state, stepUpRetried: true });
        }
        if (res.status === 401 && code === "UNAUTHORIZED" && !PRE_SESSION.test(path)) {
          const reason = details && typeof details === "object" && "reason" in details ? String((details as { reason: unknown }).reason) : null;
          hooks.unauthorized(reason);
        }
      }
      throw new ApiError(res.status, code, message, details);
    }
    if (res.status === 401 || res.status === 403) throw new ApiError(res.status, "UNAUTHORIZED", "The server refused this request. Sign in again.");
    if (sameOrigin && (res.status === 502 || res.status === 503 || res.status === 504)) throw new ApiError(res.status, "NODE_UNREACHABLE", "Cannot reach the Payminto server. Check that it is running.");
    throw new ApiError(res.status, "HTTP_ERROR", `Request to ${path} failed with status ${res.status}.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "(root)";
    if (process.env.NODE_ENV !== "production") console.warn(`[api] shape mismatch on ${path}`, parsed.error.issues, json);
    throw new ApiError(res.status, "SHAPE_MISMATCH", `Unexpected response shape from ${path} at ${where}: ${issue?.message ?? "invalid"}.`, parsed.error.issues);
  }
  return parsed.data;
}
