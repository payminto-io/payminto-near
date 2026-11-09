export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values are never written to logs. */
const SECRET_KEYS = /^(operatorKey|privateKey|adminToken|apiKey|api_key|authorization|token_secret|password|secret|hspApiKey|signerProof)$/i;

export type Logger = {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
};

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message.split("\n")[0] };
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : sanitize(v, depth + 1);
  return out;
}

/** Structured JSON-lines logger. Known secret fields are redacted, bigints stringified. */
export function createLogger(opts: { level?: LogLevel; base?: Record<string, unknown>; sink?: (line: string) => void } = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const base = opts.base ?? {};
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(sanitize({ ...base, ...fields }) as object) }));
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
