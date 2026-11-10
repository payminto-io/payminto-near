import { join } from "node:path";
import { keypairFromSeed, type AccountId, type Keypair } from "@payminto/chain";
import { base58 } from "@scure/base";

/** The file reads the key loader needs. Tests pass an in-memory tree. */
export type KeyFiles = {
  readFile(path: string): string;
  /** File names in a directory; throws when it is not a directory. */
  listDir(path: string): string[];
};

/** A problem the person at the terminal can fix. The message never contains key material or file contents. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/** The directory name NEAR tools use under `~/.near-credentials` for each network. */
export const credentialsNetwork = (network: "near:testnet" | "near:sandbox"): string => (network === "near:testnet" ? "testnet" : "localnet");

/**
 * Turns `ed25519:<base58>` into a keypair. NEAR tools write the 64-byte form (seed then public key); the 32-byte seed
 * alone is accepted too. Error messages describe the shape only.
 */
export function keypairFromSecret(secret: string): Keypair {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(secret.trim());
  if (!m) throw new KeyError("the secret key is not in the form ed25519:<base58>");
  let raw: Uint8Array;
  try {
    raw = base58.decode(m[1]!);
  } catch {
    throw new KeyError("the secret key is not valid base58");
  }
  if (raw.length !== 32 && raw.length !== 64) throw new KeyError("the secret key must decode to 32 or 64 bytes");
  const pair = keypairFromSeed(raw.slice(0, 32));
  if (raw.length === 64) {
    const stated = `ed25519:${base58.encode(raw.slice(32))}`;
    if (stated !== pair.publicKey) throw new KeyError("the secret key is damaged: its two halves do not belong together");
  }
  return pair;
}

function parseKeyFile(text: string, path: string, owner: AccountId): Keypair {
  const trimmed = text.trim();
  let secret: unknown = trimmed;
  if (trimmed.startsWith("{")) {
    let j: { account_id?: unknown; private_key?: unknown; secret_key?: unknown };
    try {
      j = JSON.parse(trimmed) as typeof j;
    } catch {
      throw new KeyError(`${path} is not valid JSON. It should be a NEAR credentials file with a private_key field.`);
    }
    if (typeof j.account_id === "string" && j.account_id !== owner) {
      throw new KeyError(`${path} holds a key for ${j.account_id}, not for ${owner}. Pass the key file of ${owner}, or fix --owner.`);
    }
    secret = j.private_key ?? j.secret_key;
    if (typeof secret !== "string") throw new KeyError(`${path} has no private_key field. It should be a NEAR credentials file.`);
  }
  try {
    return keypairFromSecret(secret as string);
  } catch (err) {
    throw new KeyError(`${path}: ${err instanceof Error ? err.message : "unreadable key"}. It should be a NEAR credentials file or one line with ed25519:<base58>.`);
  }
}

/**
 * Loads the owner's key from `--key-file`, or from the NEAR credentials directory: `<dir>/<network>/<owner>.json`, or
 * the single key file in `<dir>/<network>/<owner>/`. The key never comes from an argument or an environment variable.
 */
export function loadOwnerKey(o: { owner: AccountId; network: "near:testnet" | "near:sandbox"; keyFile?: string; credentialsDir: string; files: KeyFiles }): { keypair: Keypair; path: string } {
  const read = (path: string): string | null => {
    try {
      return o.files.readFile(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
      throw new KeyError(`cannot read ${path} (${code ?? "error"}). Check the file's permissions.`);
    }
  };

  if (o.keyFile) {
    const text = read(o.keyFile);
    if (text === null) throw new KeyError(`--key-file ${o.keyFile} does not exist. Pass the path of the owner's NEAR credentials file.`);
    return { keypair: parseKeyFile(text, o.keyFile, o.owner), path: o.keyFile };
  }

  const dir = join(o.credentialsDir, credentialsNetwork(o.network));
  const single = join(dir, `${o.owner}.json`);
  const text = read(single);
  if (text !== null) return { keypair: parseKeyFile(text, single, o.owner), path: single };

  const perKeyDir = join(dir, o.owner);
  let names: string[] = [];
  try {
    names = o.files.listDir(perKeyDir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    names = [];
  }
  if (names.length === 1) {
    const path = join(perKeyDir, names[0]!);
    const one = read(path);
    if (one !== null) return { keypair: parseKeyFile(one, path, o.owner), path };
  }
  if (names.length > 1) {
    throw new KeyError(`${perKeyDir} holds ${names.length} keys (${names.join(", ")}). Choose one with --key-file <path>.`);
  }
  throw new KeyError(`no key for ${o.owner} in ${dir}. Pass --key-file <path to the owner's NEAR credentials file>, or --credentials-dir if your keys live elsewhere.`);
}
