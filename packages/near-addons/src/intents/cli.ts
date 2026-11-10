#!/usr/bin/env node
/**
 * payminto-exit: swap USDC held on NEAR mainnet to another asset or chain through 1Click.
 * It holds no key and never signs or sends a transaction. It prints the transfer for the human to send from their own
 * wallet, then reads the swap status. Run `payminto-exit help` for usage.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RPC_URLS, ViewRpc, storageRegistration } from "../rpc.ts";
import { OneClickClient, OneClickError, isTerminal, pollStatus, type FetchLike } from "./client.ts";
import { exitPlan, exitQuoteRequest, nearCliCommands, type Registration } from "./plan.ts";
import { verifyQuoteSignature } from "./signature.ts";
import { NEAR_MAINNET_USDC, type StatusResponse } from "./types.ts";

export type CliDeps = {
  fetch?: FetchLike;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  writeFile?: (path: string, data: string) => void;
  /** Only for tests with synthetic quotes. */
  managerPublicKey?: string;
};

export const USAGE = `payminto-exit - swap USDC on NEAR mainnet through 1Click. Holds no key; never signs or sends.

  payminto-exit tokens [--chain <blockchain>] [--symbol <SYMBOL>]
  payminto-exit quote --to <assetId> --amount <atomic> --recipient <address> --sender <account.near>
                      [--slippage <bps>] [--token <nep141 contract>] [--mainnet] [--save <file>] [--rpc <url>]
  payminto-exit status --deposit <address> [--memo <memo>] [--watch] [--interval-ms <n>] [--timeout-ms <n>]
  payminto-exit submit --deposit <address> --tx <hash> --sender <account.near>

quote is dry by default: it shows the price and needs no deposit address.
--mainnet asks for a real deposit address and prints the one transfer you must sign yourself on NEAR mainnet.
--amount is in atomic units (USDC has 6 decimals: 10 USDC is 10000000).
ONECLICK_API_KEY, if set, is sent as X-API-Key; without it 1Click adds a 25 bps fee.`;

type Args = { cmd: string; flags: Map<string, string | true> };

export function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), true);
    else {
      flags.set(a.slice(2), next);
      i++;
    }
  }
  return { cmd, flags };
}

function str(a: Args, name: string, required: true): string;
function str(a: Args, name: string, required?: false): string | undefined;
function str(a: Args, name: string, required = false): string | undefined {
  const v = a.flags.get(name);
  if (v === true) throw new Error(`--${name} needs a value`);
  if (v === undefined && required) throw new Error(`--${name} is required`);
  return v;
}

function int(a: Args, name: string, fallback: number): number {
  const v = str(a, name);
  if (v === undefined) return fallback;
  if (!/^[0-9]+$/.test(v)) throw new Error(`--${name} must be a whole number`);
  return Number(v);
}

const statusLine = (s: StatusResponse): string => {
  const d = s.swapDetails;
  const parts = [`${s.updatedAt} ${s.status}`];
  if (d.amountOutFormatted) parts.push(`out ${d.amountOutFormatted}`);
  if (d.refundedAmountFormatted) parts.push(`refunded ${d.refundedAmountFormatted}${d.refundReason ? ` (${d.refundReason})` : ""}`);
  for (const t of d.destinationChainTxHashes ?? []) parts.push(`dest tx ${t.hash}`);
  return parts.join("  ");
};

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    err((e as Error).message);
    err(USAGE);
    return 64;
  }
  const client = new OneClickClient({ apiKey: env.ONECLICK_API_KEY, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

  try {
    switch (a.cmd) {
      case "tokens": {
        const chain = str(a, "chain");
        const symbol = str(a, "symbol")?.toUpperCase();
        const list = (await client.tokens()).filter((t) => (!chain || t.blockchain === chain) && (!symbol || t.symbol.toUpperCase() === symbol));
        for (const t of list) out(`${t.blockchain.padEnd(10)} ${t.symbol.padEnd(8)} ${String(t.decimals).padStart(2)}  ${t.assetId}`);
        out(`${list.length} tokens`);
        return 0;
      }

      case "quote": {
        const wet = a.flags.get("mainnet") === true;
        const sender = str(a, "sender", true);
        const asked = exitQuoteRequest(
          {
            originToken: str(a, "token") ?? NEAR_MAINNET_USDC,
            destinationAsset: str(a, "to", true),
            amount: BigInt(str(a, "amount", true)),
            recipient: str(a, "recipient", true),
            refundTo: sender,
            slippageBps: int(a, "slippage", 100),
            dry: !wet,
          },
          now(),
        );
        const res = await client.quote(asked);
        const q = res.quote;
        const signed = verifyQuoteSignature(res, deps.managerPublicKey);
        out(`${wet ? "WET" : "DRY"} quote ${res.correlationId} at ${res.timestamp}`);
        out(`  in   ${q.amountInFormatted} (${q.amountIn} atomic) of ${asked.originAsset}`);
        out(`  out  ${q.amountOutFormatted} (${q.amountOut} atomic), at least ${q.minAmountOut} atomic after slippage, of ${asked.destinationAsset}`);
        out(`  to   ${asked.recipient}`);
        out(`  ~${q.timeEstimate}s after the deposit lands; refund fee ${q.refundFee ?? "n/a"}, withdraw fee ${q.withdrawFee ?? "n/a"}`);
        out(`  1Click signature: ${signed ? "valid" : "INVALID"}`);
        const save = str(a, "save");
        if (save) {
          (deps.writeFile ?? ((p, d) => writeFileSync(p, d)))(save, JSON.stringify(res, null, 2));
          out(`  saved the full quote to ${save}; keep it to resolve disputes`);
        }
        if (!wet) {
          out("Dry quote: no deposit address was created and nothing can be sent. Rerun with --mainnet for a real one.");
          return signed ? 0 : 2;
        }

        let reg: Registration = { registered: "unknown", minDeposit: "1250000000000000000000" };
        const depositAddress = q.depositAddress ?? "";
        if (depositAddress) {
          try {
            const rpc = new ViewRpc(str(a, "rpc") ?? RPC_URLS.mainnet, deps.fetch);
            const r = await storageRegistration(rpc, asked.originAsset.slice("nep141:".length), depositAddress);
            reg = r.registered ? { registered: true } : { registered: false, minDeposit: r.minDeposit };
          } catch (e) {
            out(`  could not read token registration (${(e as Error).message}); including a registration_only storage_deposit`);
          }
        }
        const plan = exitPlan(asked, res, sender, reg, { now: now(), ...(deps.managerPublicKey ? { managerPublicKey: deps.managerPublicKey } : {}) });
        if (plan.refusals.length) {
          err("REFUSED: do not send anything for this quote.");
          for (const r of plan.refusals) err(`  - ${r}`);
          return 2;
        }
        out("");
        out("HUMAN STEP - NEAR MAINNET, REAL FUNDS. This tool does not send it. Sign it yourself from your own wallet:");
        out(`  signer:   ${plan.sender}`);
        out(`  deposit:  ${plan.depositAddress}`);
        out(`  amount:   ${plan.amountIn} atomic`);
        out(`  deadline: ${plan.deadline} (refunded to ${plan.sender} if the swap is not done by then)`);
        out("Wallet transaction (one transaction, actions in order):");
        out(JSON.stringify(plan.tx, null, 2));
        out("Or with near-cli-rs, in this order:");
        for (const c of nearCliCommands(plan)) out(`  ${c}`);
        out("After it lands, optionally tell 1Click, then watch the status:");
        out(`  payminto-exit submit --deposit ${plan.depositAddress} --tx <tx hash> --sender ${plan.sender}`);
        out(`  payminto-exit status --deposit ${plan.depositAddress} --watch`);
        return 0;
      }

      case "status": {
        const deposit = str(a, "deposit", true);
        const memo = str(a, "memo");
        if (a.flags.get("watch") !== true) {
          const s = await client.status(deposit, memo);
          out(statusLine(s));
          return 0;
        }
        const { final, last } = await pollStatus(client, deposit, {
          ...(memo ? { depositMemo: memo } : {}),
          intervalMs: int(a, "interval-ms", 5_000),
          timeoutMs: int(a, "timeout-ms", 30 * 60_000),
          onUpdate: (s) => out(statusLine(s)),
          now,
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        });
        if (!final) out(`still ${last.status}; stopped watching`);
        return final && last.status === "SUCCESS" ? 0 : isTerminal(last.status) ? 3 : 4;
      }

      case "submit": {
        const s = await client.submitDeposit({ depositAddress: str(a, "deposit", true), txHash: str(a, "tx", true), nearSenderAccount: str(a, "sender", true) });
        out(statusLine(s));
        return 0;
      }

      case "help":
      case "--help":
        out(USAGE);
        return 0;

      default:
        err(`unknown command ${a.cmd}`);
        err(USAGE);
        return 64;
    }
  } catch (e) {
    if (e instanceof OneClickError) err(e.message);
    else err(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.argv.slice(2));
}
