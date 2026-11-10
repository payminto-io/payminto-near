import { z } from "zod";
import { generateKeypair, keypairFromSeed, toHex, zPublicKey, type Keypair, type PublicKey } from "@payminto/protocol";

/**
 * The agent's ed25519 key on disk: a JSON file with mode 0600 under `~/.payminto/agent/`, written by
 * `payminto-agent keygen` and read by the MCP wallet. The key signs vouchers only; it has no NEAR account and no gas.
 * Nothing here ever prints, logs or puts the secret in an error message.
 */
export const AGENT_KEY_FORMAT = "payminto.agent-key.v1";

const keyFileSchema = z.strictObject({
  format: z.literal(AGENT_KEY_FORMAT),
  publicKey: zPublicKey,
  /** The 32-byte ed25519 seed as 64 lowercase hex characters. */
  secretKey: z.string().regex(/^[0-9a-f]{64}$/),
});

export class AgentKeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyFileError";
  }
}

type Builtins = { fs: typeof import("node:fs"); path: typeof import("node:path"); os: typeof import("node:os") };

function node(): Builtins {
  // Node built-ins load at runtime, so the SDK still imports in a browser or edge runtime.
  const builtin = typeof process !== "undefined" ? process.getBuiltinModule : undefined;
  if (!builtin) throw new AgentKeyFileError("agent key files need Node.js");
  return { fs: builtin("node:fs") as Builtins["fs"], path: builtin("node:path") as Builtins["path"], os: builtin("node:os") as Builtins["os"] };
}

/** `$PAYMINTO_DATA_DIR/agent/agent-key.json`, by default `~/.payminto/agent/agent-key.json`. */
export function defaultAgentKeyPath(env: Record<string, string | undefined> = process.env): string {
  const { path, os } = node();
  return path.join(env.PAYMINTO_DATA_DIR ?? path.join(os.homedir(), ".payminto"), "agent", "agent-key.json");
}

/**
 * Generates a key and writes it with mode 0600 (its directory 0700). Refuses to replace an existing file unless
 * `force`; the write is atomic either way, so a crash never leaves a half-written key. Returns only the public key.
 */
export function writeAgentKeyFile(file: string, o: { force?: boolean } = {}): { path: string; publicKey: PublicKey } {
  const { fs, path } = node();
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!o.force && fs.existsSync(target)) throw new AgentKeyFileError(`${target} already exists; pass --force to replace it (the old key stops working for its Budget)`);
  const kp = generateKeypair();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify({ format: AGENT_KEY_FORMAT, publicKey: kp.publicKey, secretKey: toHex(kp.secretKey) }, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (o.force) fs.renameSync(tmp, target);
    else {
      // link fails if the target appeared meanwhile, so a key is never silently overwritten.
      fs.linkSync(tmp, target);
      fs.rmSync(tmp);
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new AgentKeyFileError(`${target} already exists; pass --force to replace it`);
    throw err;
  }
  fs.chmodSync(target, 0o600);
  return { path: target, publicKey: kp.publicKey };
}

/** Reads a key file, refusing one that others can read (on POSIX) or that does not match its own public key. */
export function readAgentKeyFile(file: string): Keypair {
  const { fs, path } = node();
  const target = path.resolve(file);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new AgentKeyFileError(`no agent key at ${target}; run \`payminto-agent keygen\` to create one`);
  }
  if (!stat.isFile()) throw new AgentKeyFileError(`${target} is not a file`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new AgentKeyFileError(`${target} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600 ${target}`);
  }
  let parsed: z.infer<typeof keyFileSchema>;
  try {
    parsed = keyFileSchema.parse(JSON.parse(fs.readFileSync(target, "utf8")));
  } catch {
    // Never echo the content: it holds the secret.
    throw new AgentKeyFileError(`${target} is not a Payminto agent key file (${AGENT_KEY_FORMAT})`);
  }
  const kp = keypairFromSeed(Uint8Array.from(Buffer.from(parsed.secretKey, "hex")));
  if (kp.publicKey !== parsed.publicKey) throw new AgentKeyFileError(`${target}: the secret key does not match its public key`);
  return kp;
}
