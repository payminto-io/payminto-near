import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/**
 * The bearer token of the HTTP transport. An MCP server over HTTP can spend (the wallet) or act for a business (the
 * merchant server), and loopback is shared by every process on the machine, so a Host check is not enough: each
 * request must carry a secret that only the operator's client has.
 */
export const httpTokenSchema = z.string().regex(/^[A-Za-z0-9._~+/=-]{32,256}$/, "must be 32 to 256 characters of A-Z a-z 0-9 . _ ~ + / = -");

/** Where the token comes from: the environment, or a file that is created on first start. Never the token in a log. */
export type HttpTokenSource = { kind: "env"; token: string } | { kind: "file"; path: string };

export function httpTokenSource(e: { MCP_HTTP_TOKEN?: string; MCP_HTTP_TOKEN_FILE?: string; PAYMINTO_DATA_DIR?: string }, name = "http-token"): HttpTokenSource {
  if (e.MCP_HTTP_TOKEN) return { kind: "env", token: e.MCP_HTTP_TOKEN };
  return { kind: "file", path: resolve(e.MCP_HTTP_TOKEN_FILE ?? join(e.PAYMINTO_DATA_DIR ?? join(homedir(), ".payminto"), "mcp", name)) };
}

export class HttpTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpTokenError";
  }
}

/**
 * The token to require. From a file: an existing one is reused if only its owner can read it, otherwise a fresh
 * 256-bit token is written with mode 0600 in a 0700 directory. Errors name the path, never the token.
 */
export function resolveHttpToken(src: HttpTokenSource): { token: string; generated: boolean; path: string | null } {
  if (src.kind === "env") return { token: src.token, generated: false, path: null };
  const { path } = src;
  let mode: number | null = null;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new HttpTokenError(`${path} is not a regular file`);
    mode = st.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err instanceof HttpTokenError ? err : new HttpTokenError(`cannot read the token file ${path}`);
  }
  if (mode !== null) {
    if ((mode & 0o077) !== 0) throw new HttpTokenError(`${path} is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it, or delete it to get a new token`);
    const token = readFileSync(path, "utf8").trim();
    if (!httpTokenSchema.safeParse(token).success) throw new HttpTokenError(`${path} does not hold a valid token; delete it to get a new one`);
    return { token, generated: false, path };
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // "wx": fail rather than follow or overwrite anything that appeared at the path in the meantime.
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  return { token, generated: true, path };
}

/**
 * True when `authorization` is `Bearer <token>`. Both sides are hashed first, so the comparison always runs over 32
 * bytes in constant time and leaks neither the token's length nor how much of a guess was right.
 */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  const m = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  const equal = timingSafeEqual(digest(m?.[1] ?? ""), digest(token));
  return m !== null && equal;
}
