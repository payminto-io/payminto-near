import type { Context } from "hono";
import { z } from "zod";
import { getAddress, isAddress, type Hex } from "viem";
import { ApiError } from "../errors.ts";

// Validation helpers for the gateway routes (zod at the trust boundary), the same rules as api.ts.

export const zAddress = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));
export const zBytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 32-byte hex")
  .transform((v) => v.toLowerCase() as Hex);
export const zHex = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex")
  .transform((v) => v as Hex);
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
