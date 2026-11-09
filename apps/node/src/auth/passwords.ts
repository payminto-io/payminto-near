import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { COMMON_PASSWORDS } from "./common-passwords.ts";

/**
 * Password hashing (PRODUCT.md 4.3): scrypt from node:crypto through the async API (never blocks the event loop),
 * 16-byte random salt per user, 32-byte output, parameters stored with the hash so they can be raised later:
 * `scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>`. A sign-in with weaker stored parameters rehashes on success.
 */
export const DEFAULT_SCRYPT_LOG_N = 17;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
/** 256 MiB: N=2^17, r=8 needs 128 MiB, and scrypt refuses to run when maxmem is too small. */
const MAXMEM = 256 * 1024 * 1024;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

function scryptAsync(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string, logN = DEFAULT_SCRYPT_LOG_N): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, { N: 2 ** logN, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${logN}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

type Parsed = { logN: number; r: number; p: number; salt: Buffer; key: Buffer };

function parse(stored: string): Parsed | null {
  const m = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) return null;
  const logN = Number(m[1]);
  if (logN < 10 || logN > 22) return null;
  return { logN, r: Number(m[2]), p: Number(m[3]), salt: Buffer.from(m[4]!, "base64"), key: Buffer.from(m[5]!, "base64") };
}

/** A fixed hash that unknown emails are checked against, so timing does not reveal which emails exist. */
const dummyCache = new Map<number, Promise<string>>();
function dummyHash(logN: number): Promise<string> {
  let h = dummyCache.get(logN);
  if (!h) {
    h = hashPassword(randomBytes(24).toString("base64"), logN);
    dummyCache.set(logN, h);
  }
  return h;
}

/**
 * Constant-time check of `password` against `stored`. With `stored` null (unknown email) it still spends one hash on a
 * dummy and returns false. `rehash` is true when the stored parameters are below `logN`.
 */
export async function verifyPassword(password: string, stored: string | null, logN = DEFAULT_SCRYPT_LOG_N): Promise<{ ok: boolean; rehash: boolean }> {
  const parsed = parse(stored ?? "") ?? parse(await dummyHash(logN))!;
  const key = await scryptAsync(password, parsed.salt, { N: 2 ** parsed.logN, r: parsed.r, p: parsed.p, maxmem: MAXMEM });
  const ok = stored !== null && parse(stored) !== null && key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  return { ok, rehash: ok && (parsed.logN < logN || parsed.r !== R || parsed.p !== P) };
}

export type PasswordProblem = "too_short" | "too_long" | "common" | "equals_email";

/**
 * Length 12 to 256, not the email (or its local part), not a common password or an obvious pattern. No composition
 * rules (NIST 800-63B). Shorter common passwords are already refused by length, so the bundled list holds long ones.
 */
export function passwordProblem(password: string, ctx: { email?: string; extra?: string[] } = {}): PasswordProblem | null {
  const chars = [...password];
  if (chars.length < PASSWORD_MIN) return "too_short";
  if (chars.length > PASSWORD_MAX) return "too_long";
  const lower = password.toLowerCase();
  const email = ctx.email?.toLowerCase();
  if (email && (lower === email || lower === email.split("@")[0])) return "equals_email";
  if (COMMON_PASSWORDS.has(lower)) return "common";
  for (const word of ctx.extra ?? []) if (word && lower.replace(/[^a-z0-9]/g, "") === word.toLowerCase().replace(/[^a-z0-9]/g, "")) return "common";
  // One repeated character or a short repeated unit ("abcabcabcabc"), and straight runs ("123456789012", "abcdefghijkl").
  if (/^(.{1,4})\1+$/.test(lower)) return "common";
  const codes = chars.map((ch) => ch.codePointAt(0)!);
  const step = codes[1]! - codes[0]!;
  if ((step === 1 || step === -1) && codes.every((cp, i) => i === 0 || cp - codes[i - 1]! === step || (step === 1 && codes[i - 1] === 57 && cp === 48))) return "common";
  // A common word followed only by digits or symbols ("password1234!", "qwertyuiop12").
  const stem = lower.replace(/[\d\W_]+$/, "");
  if (stem.length >= 4 && stem.length < lower.length && (COMMON_STEMS.has(stem) || COMMON_PASSWORDS.has(stem))) return "common";
  return null;
}

const COMMON_STEMS = new Set([
  "password", "passw0rd", "p@ssword", "p@ssw0rd", "qwerty", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbnm", "letmein", "welcome",
  "admin", "administrator", "iloveyou", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "master", "shadow",
  "superman", "batman", "trustno1", "changeme", "secret", "abc", "abcd", "test", "payminto", "hashkey", "bitcoin", "ethereum",
  "crypto", "wallet", "default", "login", "user", "guest", "root", "starwars", "whatever", "freedom", "michael", "jennifer",
]);
