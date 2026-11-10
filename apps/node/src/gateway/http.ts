import type { Context } from "hono";
import { z } from "zod";
import { isAccountId, isPublicKey, type AccountId, type Id32, type PublicKey, type Sig64 } from "@payminto/protocol";
import { ApiError } from "../errors.ts";

// Validation helpers for the gateway routes (zod at the trust boundary), the same rules as api.ts.

export const zAccount = z
  .string()
  .refine((v) => isAccountId(v), "must be a NEAR account id")
  .transform((v) => v as AccountId);
export const zId32 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be 32 bytes as 64 lowercase hex characters")
  .transform((v) => v as Id32);
export const zSig = z
  .string()
  .regex(/^[0-9a-f]{128}$/, "must be a 64-byte signature as 128 lowercase hex characters")
  .transform((v) => v as Sig64);
export const zPublicKey = z
  .string()
  .refine((v) => isPublicKey(v), "must be an ed25519:<base58> public key")
  .transform((v) => v as PublicKey);
/** A transaction hash: base58 on NEAR (43 or 44 characters); the in-memory test chain uses short dashed ids. */
export const zTxHash = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "must be a transaction hash");
// abort: a later .refine((v) => BigInt(v) ...) must never see a string that failed the pattern; zod 4 runs it otherwise,
// and BigInt("1.00") throws, which turned a bad request into a 500.
export const zUint = z.string().regex(/^(0|[1-9]\d{0,77})$/, { message: "must be a decimal string of base units (1.00 USDC is 1000000)", abort: true });
export const zAmount = zUint.refine((v) => BigInt(v) > 0n, "must be positive").transform((v) => BigInt(v));
export const zUrl = z.url().max(2000);

export async function rawBody(c: Context): Promise<string> {
  return c.req.text();
}

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
  }
  return parse(raw, schema, "request body failed validation");
}

export function parse<T extends z.ZodType>(raw: unknown, schema: T, message: string): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", message, { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}

export function limitOf(c: Context, def = 50, max = 200): number {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new ApiError(400, "VALIDATION_ERROR", "limit must be a positive integer");
  return Math.min(Number(raw), max);
}

export function cursorOf(c: Context): number | undefined {
  const raw = c.req.query("cursor");
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, "VALIDATION_ERROR", "invalid cursor");
  return Number(raw);
}
