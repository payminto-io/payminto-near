import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The documented local dev key (docs/OPERATIONS.md): base64 of the 32 ASCII bytes "payminto-dev-agent-secrets-key!!".
 * The node uses it when AGENT_SECRETS_KEY is unset on a local chain and refuses it on NEAR testnet.
 */
export const DEV_AGENT_SECRETS_KEY = "cGF5bWludG8tZGV2LWFnZW50LXNlY3JldHMta2V5ISE=";

/** A sealed secret as stored: base64 ciphertext, 12-byte IV and 16-byte GCM tag, plus the server key version. */
export type Sealed = { ciphertext: string; iv: string; tag: string; version: number };

/** What a ciphertext is bound to: the owning business and the row (connection or agent id). */
export type SecretBinding = { merchantId: string; rowId: string };

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/** Decodes a base64 server key; it must be exactly 32 bytes. The message never contains the value. */
export function parseSecretsKey(b64: string, name = "AGENT_SECRETS_KEY"): Buffer {
  const trimmed = b64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new SecretError(`${name}: must be base64 (try: openssl rand -base64 32)`);
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new SecretError(`${name}: must decode to 32 bytes, got ${key.length} (try: openssl rand -base64 32)`);
  return key;
}

const aadOf = (b: SecretBinding) => Buffer.from(`payminto-agent-secret\n${b.merchantId}\n${b.rowId}`, "utf8");

/**
 * AES-256-GCM for model API keys and skill provider keys (docs/AGENTS.md section 2). The associated data binds a
 * ciphertext to its business and row, so a ciphertext copied to another row or business fails to decrypt. New
 * secrets are sealed with the current key version; older versions stay readable while their key is configured.
 */
export class SecretBox {
  readonly currentVersion: number;
  readonly #keys: Map<number, Buffer>;

  constructor(keys: Map<number, Buffer>, currentVersion: number) {
    if (!keys.has(currentVersion)) throw new SecretError(`no agent secrets key for version ${currentVersion}`);
    for (const [v, k] of keys) if (k.length !== 32) throw new SecretError(`agent secrets key version ${v} is not 32 bytes`);
    this.#keys = new Map(keys);
    this.currentVersion = currentVersion;
  }

  hasVersion(version: number): boolean {
    return this.#keys.has(version);
  }

  seal(plaintext: string, binding: SecretBinding): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#keys.get(this.currentVersion)!, iv);
    cipher.setAAD(aadOf(binding));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), version: this.currentVersion };
  }

  /** Throws SecretError (never with key material) when the key version is unknown or the ciphertext does not verify. */
  open(s: Sealed, binding: SecretBinding): string {
    const key = this.#keys.get(s.version);
    if (!key) throw new SecretError(`secret was sealed with key version ${s.version}, which this server does not have`);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
      decipher.setAAD(aadOf(binding));
      decipher.setAuthTag(Buffer.from(s.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(s.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretError("secret does not decrypt for this row (wrong key, business or row)");
    }
  }
}

/** Last 4 characters of a key, for display. */
export function keyHint(key: string): string {
  return key.length <= 8 ? "…" : key.slice(-4);
}
