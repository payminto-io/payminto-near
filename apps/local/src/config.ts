import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainnetAccount } from "./intents-live.ts";

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
  /**
   * The any-chain checkout. Simulated (the default): a fake 1Click server and this chain standing in for mainnet. Live
   * (`--intents live`, never from the environment): the real 1Click API and NEAR mainnet for that rail only.
   */
  intents: IntentsOption;
};

export type IntentsOption =
  | { mode: "simulated" }
  | {
      mode: "live";
      /** The business's own NEAR mainnet account the USDC lands in (`--intents-payout`). */
      payout: string;
      /** Accounts NEAR RPC can find 1Click's delivery transactions by (`--intents-senders`); empty uses only the payout account. */
      senders: string[];
      /** A NEAR mainnet RPC (`--intents-rpc`); null uses the node's default, https://rpc.mainnet.near.org. */
      rpcUrl: string | null;
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
  "",
  "  --intents live --intents-payout <account> [--intents-senders <a,b>] [--intents-rpc <https url>]",
  "              LIVE - real money on NEAR mainnet: the any-chain checkout uses the real 1Click API and NEAR mainnet,",
  "              and its USDC lands in <account>, your own NEAR mainnet account. Everything else stays on the local chain.",
  "              Never from an environment variable. See docs/LIVE_RUN.md.",
].join("\n");

const PORT_FLAGS: Record<string, keyof Ports> = { "--dashboard-port": "dashboard", "--node-port": "node", "--signer-port": "signer", "--services-port": "services", "--relayer-port": "relayer" };

const INTENTS_FLAGS = ["--intents", "--intents-payout", "--intents-senders", "--intents-rpc"] as const;

/**
 * Reads the command line, and nothing else: no environment variable changes what runs, least of all live mode.
 */
export function parseArgs(argv: readonly string[]): LocalOptions {
  const o: LocalOptions = { mode: "run", empty: false, ports: {}, noDashboard: false, intents: { mode: "simulated" } };
  const live: Partial<Record<(typeof INTENTS_FLAGS)[number], string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    const [name, inline] = a.split(/=(.*)/s) as [string, string | undefined];
    if ((INTENTS_FLAGS as readonly string[]).includes(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value\n\n${USAGE}`);
      live[name as (typeof INTENTS_FLAGS)[number]] = v;
      continue;
    }
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
  if (o.mode === "reset" && (o.empty || Object.keys(o.ports).length > 0 || Object.keys(live).length > 0)) throw new UsageError(`--reset takes no other flag\n\n${USAGE}`);
  o.intents = intentsOption(live, o.mode);
  if (o.noDashboard && o.mode !== "check") throw new UsageError(`--no-dashboard only applies to --check\n\n${USAGE}`);
  const chosen = Object.values(o.ports);
  if (new Set(chosen).size !== chosen.length) throw new UsageError("each port flag needs a different port");
  return o;
}

/** `--intents` and its companions: live only when asked for by name, and then only with a NEAR mainnet payout account. */
function intentsOption(f: Partial<Record<(typeof INTENTS_FLAGS)[number], string>>, mode: Mode): IntentsOption {
  const which = f["--intents"] ?? "simulated";
  if (which !== "simulated" && which !== "live") throw new UsageError(`--intents is simulated or live, not ${which}\n\n${USAGE}`);
  if (which === "simulated") {
    const stray = (["--intents-payout", "--intents-senders", "--intents-rpc"] as const).find((k) => f[k] !== undefined);
    if (stray) throw new UsageError(`${stray} applies only with --intents live\n\n${USAGE}`);
    return { mode: "simulated" };
  }
  if (mode === "check") throw new UsageError("--check runs the simulated pass and never real money; drop --intents live to run it");
  const payout = f["--intents-payout"];
  if (!payout) throw new UsageError(`--intents live needs --intents-payout <your NEAR mainnet account>: the account the USDC lands in. Nothing was started.\n\n${USAGE}`);
  if (!isMainnetAccount(payout)) throw new UsageError(`--intents-payout ${payout} is not a NEAR mainnet account (for example northwind.near). Nothing was started.`);
  const senders = (f["--intents-senders"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of senders) if (!isMainnetAccount(s)) throw new UsageError(`--intents-senders: ${s} is not a NEAR mainnet account`);
  const rpc = f["--intents-rpc"];
  if (rpc !== undefined && !/^https:\/\/[^\s]+$/.test(rpc)) throw new UsageError("--intents-rpc must be an https URL of a NEAR mainnet RPC");
  return { mode: "live", payout, senders, rpcUrl: rpc ? rpc.replace(/\/+$/, "") : null };
}
