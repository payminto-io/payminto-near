export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names whose values are never written to logs. The relayer's key is the only secret it holds; signatures and
 * raw delegates are kept out too, so a log line can never be replayed as a request.
 */
const SECRET_KEYS = /^(relayerKey|privateKey|private_key|secretKey|secret_key|seed|signature|signedDelegate|authorization|password|secret)$/i;
/** A NEAR secret key anywhere in a string value (an error message, for example) is masked as well. */
const SECRET_VALUE = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}/g;

export type Logger = {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
};

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (value instanceof Error) return { name: value.name, message: (value.message.split("\n")[0] ?? "").replace(SECRET_VALUE, "[redacted]") };
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : sanitize(v, depth + 1);
  return out;
}

/** Structured JSON-lines logger. Secret fields and secret-key-shaped strings are redacted, bigints stringified. */
export function createLogger(opts: { level?: LogLevel; base?: Record<string, unknown>; sink?: (line: string) => void } = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const base = opts.base ?? {};
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, msg: msg.replace(SECRET_VALUE, "[redacted]"), ...(sanitize({ ...base, ...fields }) as object) }));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger({ level: opts.level, base: { ...base, ...fields }, sink }),
  };
}

export const silentLogger: Logger = createLogger({ sink: () => {} });
