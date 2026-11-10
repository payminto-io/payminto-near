#!/usr/bin/env node
/**
 * `pnpm verify:near`: proves a Payminto receipt against the hub on chain, with no node running and no keys.
 *
 *   pnpm verify:near --rpc-url <url> --hub <account> --receipt <receipt.json> [--batch <id>]
 *   pnpm verify:near --rpc-url <url> --hub <account> --batch <id>
 *
 * NEAR_RPC_URL and HUB_ACCOUNT work in place of the flags. Exit 0 when every check passes, 1 when any check fails,
 * 2 for bad arguments, an unreadable file, or a hub that cannot be read.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { NearRpcChain } from "@payminto/chain/node";
import { isAccountId, isId32, type Network } from "@payminto/protocol";
import { hubAccountFacts } from "./rpc.ts";
import { PROOF_LIMITS, receiptFileSchema, verifyBatch, verifyReceipt, type VerifyResult } from "./verify.ts";

const USAGE = "usage: pnpm verify:near --rpc-url <url> --hub <account> (--receipt <file> [--batch <id>] | --batch <id>)";
const out = (line: string) => process.stdout.write(`${line}\n`);
const fail = (message: string): never => {
  process.stderr.write(`verify:near: ${message}\n`);
  process.exit(2);
};

function parseArgs(argv: readonly string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--help" || a === "-h") {
      out(USAGE);
      process.exit(0);
    }
    const eq = a.indexOf("=");
    const [name, inline] = a.startsWith("--") && eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), undefined];
    if (!a.startsWith("--") || !["rpc-url", "hub", "receipt", "batch"].includes(name)) fail(`unknown argument ${a}\n${USAGE}`);
    const v = inline ?? argv[++i];
    if (v === undefined) fail(`--${name} needs a value\n${USAGE}`);
    flags.set(name, v!);
  }
  const rpcUrl = flags.get("rpc-url") ?? process.env.NEAR_RPC_URL;
  const hub = flags.get("hub") ?? process.env.HUB_ACCOUNT;
  if (!rpcUrl) fail(`--rpc-url (or NEAR_RPC_URL) is required\n${USAGE}`);
  if (!hub || !isAccountId(hub)) fail(`--hub (or HUB_ACCOUNT) must be a NEAR account id\n${USAGE}`);
  const batch = flags.get("batch");
  if (batch !== undefined && !isId32(batch)) fail("--batch must be 64 lowercase hex characters");
  const receipt = flags.get("receipt");
  if (!receipt && !batch) fail(`give --receipt, --batch or both\n${USAGE}`);
  try {
    if (!/^https?:$/.test(new URL(rpcUrl!).protocol)) fail("--rpc-url must be an http or https URL");
  } catch {
    fail("--rpc-url must be a URL");
  }
  return { rpcUrl: rpcUrl!, hub: hub!, batch, receipt };
}

const args = parseArgs(process.argv.slice(2));
// pnpm runs this from apps/demo; a relative path means the directory the command was typed in.
const base = process.env.INIT_CWD ?? process.cwd();
const file = args.receipt
  ? (() => {
      const path = isAbsolute(args.receipt) ? args.receipt : resolve(base, args.receipt);
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        return fail(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const parsed = receiptFileSchema.safeParse(json);
      if (!parsed.success) return fail(`${path} is not a Payminto receipt file: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return { path, data: parsed.data };
    })()
  : null;

// The hub's own config says which network and token it serves; nothing here trusts the receipt file for that.
let config: { admin: string; token: string; network: string };
try {
  config = await new NearRpcChain({ hub: args.hub, token: args.hub, network: "near:sandbox", rpcUrl: args.rpcUrl, operator: args.hub }).config();
} catch (err) {
  fail(`cannot read the hub ${args.hub} at ${args.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
}
if (config!.network !== "near:sandbox" && config!.network !== "near:testnet") fail(`the hub says it serves ${config!.network}; this verifier reads sandbox and testnet hubs only`);
const network = config!.network as Network;
// No operator key: this client can only read.
const chain = new NearRpcChain({ hub: args.hub, token: config!.token, network, rpcUrl: args.rpcUrl, operator: file?.data.operator ?? config!.admin });

out(`verify:near: read-only, no keys, no node. Everything below is read from ${args.rpcUrl}.`);
out(`  hub ${args.hub} serves ${network}, token ${config!.token}, admin ${config!.admin}`);
try {
  const f = await hubAccountFacts(args.rpcUrl, args.hub);
  out(`  INFO  hub account: code hash ${f.codeHash}, ${f.accessKeys} access key(s): ${f.accessKeys === 0 ? "locked, its code can never change" : "NOT locked, its code could still change"}`);
} catch (err) {
  out(`  INFO  hub account facts unavailable: ${err instanceof Error ? err.message : String(err)}`);
}

let result: VerifyResult;
try {
  if (file) {
    out(`  receipt ${file.path}: call ${file.data.receipt.callId}`);
    result = await verifyReceipt(chain, args.batch ? { ...file.data, batchId: args.batch } : file.data);
  } else {
    result = await verifyBatch(chain, args.batch!);
  }
} catch (err) {
  fail(`reading the hub failed: ${err instanceof Error ? err.message : String(err)}`);
}

for (const l of result!.lines) out(`  ${l.ok === null ? "INFO" : l.ok ? "PASS" : "FAIL"}  ${l.what}: ${l.detail}`);
const failed = result!.lines.filter((l) => l.ok === false).length;
if (file && failed === 0) out(`  ${PROOF_LIMITS}`);
out(failed === 0 ? `VERIFIED: ${result!.lines.filter((l) => l.ok === true).length} checks passed against ${args.hub}` : `NOT VERIFIED: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
