import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(DEMO_DIR, "..", "..");

export const CHAIN_KINDS = ["fake", "sandbox"] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];

/** Overall deadline per chain when neither --timeout nor DEMO_TIMEOUT_SEC is set. */
export const DEFAULT_TIMEOUT_SEC: Record<ChainKind, number> = { fake: 120, sandbox: 600 };

export type DemoConfig = {
  /** `fake`: the in-memory model of the hub, labeled simulated everywhere. `sandbox`: a fresh local near-sandbox node. */
  chain: ChainKind;
  /** Multiplies the number of paid calls in each act. 1 is the full story (about 200 calls); tests use less. */
  scale: number;
  /** Where run directories go. Defaults to apps/demo/data (git-ignored). */
  dataDir: string | undefined;
  /** The whole run, setup and shutdown included, must finish within this many seconds. */
  timeoutSec: number;
  /** Sandbox only: after the checks, keep the sandbox running for `pnpm verify:near` until Ctrl-C. */
  keep: boolean;
};

export class DemoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoConfigError";
  }
}

const USAGE = "usage: pnpm demo [--chain fake|sandbox] [--scale <n>] [--timeout <seconds>] [--keep]";

/** Flags win over DEMO_CHAIN, DEMO_SCALE, DEMO_TIMEOUT_SEC and DEMO_KEEP. */
export function loadDemoConfig(env: Record<string, string | undefined> = process.env, argv: readonly string[] = []): DemoConfig {
  let chain = env.DEMO_CHAIN ?? "fake";
  let scale = env.DEMO_SCALE ?? "1";
  let timeout = env.DEMO_TIMEOUT_SEC;
  let keep = env.DEMO_KEEP === "1";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new DemoConfigError(`${a} needs a value; ${USAGE}`);
      return v;
    };
    if (a === "--chain") chain = value();
    else if (a.startsWith("--chain=")) chain = a.slice("--chain=".length);
    else if (a === "--scale") scale = value();
    else if (a === "--timeout") timeout = value();
    else if (a === "--keep") keep = true;
    else if (a === "run" || a === "--") continue;
    else throw new DemoConfigError(`unknown argument ${a}; ${USAGE}`);
  }
  if (!(CHAIN_KINDS as readonly string[]).includes(chain)) throw new DemoConfigError(`--chain ${chain} is not one of ${CHAIN_KINDS.join(", ")}; ${USAGE}`);
  const n = Number(scale);
  if (!Number.isFinite(n) || n <= 0 || n > 5) throw new DemoConfigError("--scale must be a number above 0 and at most 5");
  const kind = chain as ChainKind;
  const t = timeout === undefined ? DEFAULT_TIMEOUT_SEC[kind] : Number(timeout);
  if (!Number.isInteger(t) || t < 10 || t > 3600) throw new DemoConfigError("--timeout must be a whole number of seconds from 10 to 3600");
  if (keep && kind !== "sandbox") throw new DemoConfigError("--keep only applies to --chain sandbox");
  return { chain: kind, scale: n, dataDir: env.DEMO_DATA_DIR, timeoutSec: t, keep };
}
