import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32 without padding, in the given alphabet case. */
export function base32(bytes: Uint8Array, upper = false): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return upper ? out.toUpperCase() : out;
}

export type AuthIdKind = "usr" | "ses" | "inv" | "tok" | "sur";

/** Ids like the gateway's: prefix, underscore, 24 lowercase base32 characters (15 random bytes). */
export function newAuthId(kind: AuthIdKind): string {
  return `${kind}_${base32(randomBytes(15))}`;
}

/** A bearer secret for a cookie or an emailed link: 32 random bytes, base64url. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** One-time setup code: 32 random bytes in base32, shown in groups of four. */
export function newSetupCode(): string {
  return base32(randomBytes(32), true).match(/.{1,4}/g)!.join("-");
}

/** Dashes, spaces and case do not matter when a code is typed back. */
export function normalizeSetupCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}
