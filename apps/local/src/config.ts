import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(LOCAL_DIR, "..", "..");
export const DASHBOARD_DIR = resolve(REPO_ROOT, "apps", "dashboard");
/** The one directory this app writes to. Git-ignored. `--reset` deletes it and nothing else. */
export const DATA_DIR = resolve(LOCAL_DIR, "data");

/** The only network this stack and its signer ever serve. */
export const NETWORK = "near:sandbox" as const;
/** What near-sandbox reports as its chain id when the demo's hub factory initializes it. */
export const SANDBOX_CHAIN_ID = "localnet";

export const DEFAULT_PORTS = { dashboard: 3210, node: 4210, signer: 4211, services: 4212, relayer: 4213 } as const;
export type Ports = { dashboard: number; node: number; signer: number; services: number; relayer: number };

export type Mode = "run" | "check" | "reset" | "help";

export type LocalOptions = {
  mode: Mode;
  /** Skip the seeded activity: setup only, so every list starts empty. */
  empty: boolean;
  /** Explicit ports. Unset ports use the defaults in run mode and free ports in check mode. */
  ports: Partial<Ports>;
  /** Check mode: leave the dashboard out (the node and signer are still checked through their own HTTP). */
  noDashboard: boolean;
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = [
  "usage: pnpm local [--check] [--reset] [--empty] [--dashboard-port <n>] [--node-port <n>] [--signer-port <n>] [--services-port <n>] [--relayer-port <n>]",
  "",
  "  (no flag)   start a local NEAR node, the hub, the clearing node, the local signer and the dashboard, then wait for Ctrl-C",
  "  --check     start everything, run the scripted pass, print a checks block, stop, and exit non-zero on any failure",
  "  --reset     delete apps/local/data (through the node's reset guard) and exit",
  "  --empty     set up the accounts and logins but generate no activity",
].join("\n");

const PORT_FLAGS: Record<string, keyof Ports> = { "--dashboard-port": "dashboard", "--node-port": "node", "--signer-port": "signer", "--services-port": "services", "--relayer-port": "relayer" };

export function parseArgs(argv: readonly string[]): LocalOptions {
  const o: LocalOptions = { mode: "run", empty: false, ports: {}, noDashboard: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--check") o.mode = "check";
    else if (a === "--reset") o.mode = "reset";
    else if (a === "--help" || a === "-h") o.mode = "help";
    else if (a === "--empty") o.empty = true;
    else if (a === "--no-dashboard") o.noDashboard = true;
    else if (a in PORT_FLAGS || PORT_FLAGS[a.split("=")[0]!]) {
      const [flag, inline] = a.split("=") as [string, string | undefined];
      const raw = inline ?? argv[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isInteger(n) || n < 1024 || n > 65535) throw new UsageError(`${flag} needs a port from 1024 to 65535\n\n${USAGE}`);
      o.ports[PORT_FLAGS[flag]!] = n;
    } else throw new UsageError(`unknown argument ${a}\n\n${USAGE}`);
  }
  if (o.mode === "reset" && (o.empty || Object.keys(o.ports).length > 0)) throw new UsageError(`--reset takes no other flag\n\n${USAGE}`);
  if (o.noDashboard && o.mode !== "check") throw new UsageError(`--no-dashboard only applies to --check\n\n${USAGE}`);
  const chosen = Object.values(o.ports);
  if (new Set(chosen).size !== chosen.length) throw new UsageError("each port flag needs a different port");
  return o;
}
