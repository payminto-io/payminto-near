import { join } from "node:path";
import { parseArgs } from "node:util";
import { isAccountId, isId32 } from "@payminto/chain";
import { gasless, RpcError, ViewRpc } from "@payminto/near-addons";
import { z } from "zod";
import { DEFAULT_RPC_URLS, TGAS } from "../config.ts";
import { KeyError, loadOwnerKey, type KeyFiles } from "./keys.ts";

/** The shape of `fetch` this CLI needs. `globalThis.fetch` fits; tests pass a fake. */
export type CliFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export type CliIo = {
  fetch: CliFetch;
  files: KeyFiles;
  homedir(): string;
  out(line: string): void;
  err(line: string): void;
};

export const USAGE = `payminto-revoke - stop an agent by revoking its Budget, with no NEAR for gas.

The owner signs a NEP-366 delegate for the hub's revoke_budget call, and a Payminto relayer pays the gas.

  pnpm --filter @payminto/relayer revoke --budget <id> --owner <account> --relayer <url> [options]

  --budget <id>            The Budget id: 64 lowercase hex characters.
  --owner <account>        The NEAR account that owns the Budget.
  --relayer <url>          The relayer's base URL, for example http://127.0.0.1:8790.
  --key-file <path>        The owner's NEAR credentials file (JSON with private_key), or a file with one
                           ed25519:<base58> line. Default: ~/.near-credentials/<network>/<owner>.json.
  --credentials-dir <dir>  Use this directory instead of ~/.near-credentials.
  --rpc-url <url>          NEAR JSON-RPC used to read the key's nonce and the block height.
                           Default: the public RPC of the relayer's network.
  --ttl-blocks <n>         How many blocks the delegate stays valid. Default 120.
  --dry-run                Build, sign and print the decoded delegate, and send nothing.
  --help                   Show this text.

The key is read from a file only. It is never accepted as an argument and never printed.
Exit codes: 0 done, 1 refused or failed, 2 wrong usage.`;

const infoSchema = z.object({
  relayer: z.string().refine((v) => isAccountId(v)),
  hub: z.string().refine((v) => isAccountId(v)),
  network: z.enum(["near:testnet", "near:sandbox"]),
  methods: z.array(z.string()),
  maxGasTgas: z.number(),
});

const REVOKE_METHOD = "revoke_budget";
const READ_TIMEOUT_MS = 15_000;
const RELAY_TIMEOUT_MS = 120_000;
const EXPLORERS: Record<string, string> = { "near:testnet": "https://testnet.nearblocks.io/txns/" };

class UsageError extends Error {}
/** Something went wrong that the person can act on. The message is printed as it is. */
class CliError extends Error {}

/** Why a request failed, with the system's own reason (ECONNREFUSED and the like) when there is one. */
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const detail = cause instanceof Error ? cause.message || (cause as NodeJS.ErrnoException).code : undefined;
  return detail && detail !== err.message ? `${err.message}: ${detail}` : err.message;
}

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CliError(`${what} did not answer within ${ms / 1000} seconds. Check the URL and try again.`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const baseUrl = (raw: string, flag: string): string => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`${flag} must be an http or https URL, for example http://127.0.0.1:8790`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`${flag} must be an http or https URL`);
  if (u.username || u.password) throw new UsageError(`${flag} must not contain a user name or password`);
  return raw.replace(/\/+$/, "");
};

/**
 * `payminto-revoke`: builds the delegate for the hub's `revoke_budget`, signs it with the owner's key from a file,
 * posts it to the relayer and prints the result. Returns the process exit code.
 */
export async function runRevoke(argv: string[], io: CliIo): Promise<number> {
  try {
    return await revoke(argv, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof CliError || err instanceof KeyError) {
      io.err(err.message.charAt(0).toUpperCase() + err.message.slice(1));
      return 1;
    }
    throw err;
  }
}

async function revoke(argv: string[], io: CliIo): Promise<number> {
  // A secret key on the command line ends up in shell history and in the process list. Refuse before anything else.
  if (argv.some((a) => /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/.test(a))) {
    throw new UsageError("A secret key was passed on the command line. Never do that: it is now in your shell history. Rotate that key, and pass --key-file <path> instead.");
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        budget: { type: "string" },
        owner: { type: "string" },
        relayer: { type: "string" },
        "key-file": { type: "string" },
        "credentials-dir": { type: "string" },
        "rpc-url": { type: "string" },
        "ttl-blocks": { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : "could not read the arguments");
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const str = (name: string): string | undefined => (typeof values[name] === "string" ? (values[name] as string) : undefined);
  const budget = str("budget");
  const owner = str("owner");
  const relayerArg = str("relayer");
  const missing = [["--budget", budget], ["--owner", owner], ["--relayer", relayerArg]].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) throw new UsageError(`Missing ${missing.join(", ")}.`);
  if (!isId32(budget)) throw new UsageError("--budget must be the Budget id: 64 lowercase hex characters.");
  if (!isAccountId(owner)) throw new UsageError("--owner must be a NEAR account id, for example alice.testnet.");
  const relayerUrl = baseUrl(relayerArg!, "--relayer");
  const rpcOverride = str("rpc-url") ? baseUrl(str("rpc-url")!, "--rpc-url") : undefined;
  const ttlRaw = str("ttl-blocks") ?? "120";
  if (!/^\d{1,6}$/.test(ttlRaw) || Number(ttlRaw) < 10) throw new UsageError("--ttl-blocks must be a whole number of at least 10.");
  const ttlBlocks = BigInt(ttlRaw);
  const dryRun = values["dry-run"] === true;

  // 1. What does this relayer pay for?
  let infoText: { status: number; text: string };
  try {
    const res = await timeout(io.fetch(`${relayerUrl}/info`, { method: "GET", headers: { accept: "application/json" } }), READ_TIMEOUT_MS, `The relayer at ${relayerUrl}`);
    infoText = { status: res.status, text: await res.text() };
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Could not reach the relayer at ${relayerUrl} (${reason(err)}). Check --relayer and that the relayer is running.`);
  }
  let info: z.infer<typeof infoSchema>;
  try {
    if (infoText.status !== 200) throw new Error(`HTTP ${infoText.status}`);
    info = infoSchema.parse(JSON.parse(infoText.text));
  } catch {
    throw new CliError(`${relayerUrl}/info did not answer like a Payminto relayer (HTTP ${infoText.status}). Check that --relayer is the relayer's base URL.`);
  }
  if (!info.methods.includes(REVOKE_METHOD)) {
    throw new CliError(`This relayer does not pay for ${REVOKE_METHOD} (it pays for: ${info.methods.join(", ") || "nothing"}). Use another relayer, or revoke from a wallet with your own gas.`);
  }
  if (owner === info.hub || owner === info.relayer) throw new UsageError("--owner must be the account that owns the Budget, not the hub or the relayer.");

  // 2. The owner's key, from a file.
  const { keypair, path: keyPath } = loadOwnerKey({
    owner,
    network: info.network,
    ...(str("key-file") ? { keyFile: str("key-file")! } : {}),
    credentialsDir: str("credentials-dir") ?? join(io.homedir(), ".near-credentials"),
    files: io.files,
  });

  // 3. The key's next nonce and a short validity window, read from the chain.
  const rpcUrl = rpcOverride ?? DEFAULT_RPC_URLS[info.network];
  const rpc = new ViewRpc(rpcUrl, io.fetch);
  let params: gasless.DelegateParams;
  try {
    params = await timeout(gasless.delegateParams(rpc, owner, keypair.publicKey, ttlBlocks), READ_TIMEOUT_MS, `The NEAR RPC at ${rpcUrl}`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (err instanceof Error && /is not an access key of/.test(err.message)) {
      throw new CliError(`The key in ${keyPath} (${keypair.publicKey}) is not an access key of ${owner} on ${info.network}. Use the key file of ${owner}, or check --owner.`);
    }
    const why = err instanceof RpcError ? err.message : reason(err);
    throw new CliError(`Could not read ${owner}'s key from the NEAR RPC at ${rpcUrl} (${why.slice(0, 200)}). Check --rpc-url and your connection, then try again.`);
  }

  // 4. Build and sign. What gets printed and sent is decoded back from the signed bytes, not taken from the inputs.
  const signed = gasless.signDelegate(
    gasless.revokeBudgetDelegate({ owner, hub: info.hub, budgetId: budget, publicKey: keypair.publicKey, nonce: params.nonce, maxBlockHeight: params.maxBlockHeight }),
    keypair.secretKey,
  );
  const body = gasless.relayRequestBody(signed);
  const decoded = gasless.decodeSignedDelegate(new Uint8Array(Buffer.from(body.signedDelegate, "base64")));
  const d = decoded.delegateAction;
  const totalGas = d.actions.reduce((sum, a) => sum + (a.type === "FunctionCall" ? a.gas : 0n), 0n);
  if (totalGas > BigInt(info.maxGasTgas) * TGAS) {
    throw new CliError(`This relayer pays for at most ${info.maxGasTgas} Tgas per delegate, and a revoke attaches ${totalGas / TGAS} Tgas. Use another relayer, or revoke from a wallet with your own gas.`);
  }

  const describe = (): string[] => [
    `  sender:           ${d.senderId}`,
    `  receiver:         ${d.receiverId}`,
    ...d.actions.map((a, i) =>
      a.type === "FunctionCall"
        ? `  action ${i + 1}:         ${a.methodName}(${new TextDecoder().decode(a.args)})  gas ${a.gas / TGAS} Tgas  deposit ${a.deposit} yoctoNEAR`
        : `  action ${i + 1}:         ${a.type}`,
    ),
    `  nonce:            ${d.nonce}`,
    `  max block height: ${d.maxBlockHeight} (valid for about ${ttlBlocks} blocks from now)`,
    `  public key:       ${d.publicKey}`,
    `  signature:        ${gasless.verifySignedDelegate(decoded) ? "valid" : "INVALID"} (not shown)`,
    `  key file:         ${keyPath}`,
    `  relayer:          ${relayerUrl} (${info.relayer} on ${info.network}, pays the gas)`,
  ];

  if (dryRun) {
    io.out("Dry run: nothing was sent. Only GET /info and two read-only RPC queries were made.");
    io.out("Delegate (NEP-366), decoded from the signed bytes:");
    for (const line of describe()) io.out(line);
    io.out("To send it, run the same command without --dry-run.");
    return 0;
  }

  // 5. Hand it to the relayer, once.
  let status: number;
  let text: string;
  try {
    const res = await timeout(
      io.fetch(`${relayerUrl}/relay`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }),
      RELAY_TIMEOUT_MS,
      `The relayer at ${relayerUrl}`,
    );
    status = res.status;
    text = await res.text();
  } catch (err) {
    throw new CliError(
      `The request to ${relayerUrl}/relay failed (${reason(err)}). The relayer may or may not have received it. Do not assume either: check the Budget on the hub, then run this command again if it is still open.`,
    );
  }
  let json: { txHash?: unknown; error?: { code?: unknown; message?: unknown; outcomeUnknown?: unknown; txHash?: unknown } } = {};
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    // Reported below with the status.
  }
  if (status === 200 && typeof json.txHash === "string") {
    io.out(`Revoked: Budget ${budget} of ${owner}.`);
    io.out(`  transaction: ${json.txHash}`);
    io.out(`  gas paid by: ${info.relayer}`);
    const explorer = EXPLORERS[info.network];
    if (explorer) io.out(`  explorer:    ${explorer}${json.txHash}`);
    return 0;
  }
  const code = typeof json.error?.code === "string" ? json.error.code : `HTTP ${status}`;
  const message = typeof json.error?.message === "string" ? json.error.message : "The relayer answered without an error message. Check its logs.";
  io.err(`Not revoked (${code}): ${message}`);
  if (typeof json.error?.txHash === "string") io.err(`  transaction: ${json.error.txHash}`);
  if (json.error?.outcomeUnknown === true) io.err("  The outcome is unknown: the revoke may still land. Check the Budget on the hub before you try again.");
  return 1;
}
