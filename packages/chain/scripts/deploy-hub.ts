/**
 * Deploys the Payminto hub and locks it, on near-sandbox or NEAR testnet. Never mainnet.
 *
 * Steps, each skipped when the chain already shows it done, so a run that stopped halfway can be repeated:
 *   0. checks the hub account holds enough NEAR for the wasm, its state and a margin of its own
 *   1. hub signs: DeployContract(hub.wasm) + new({ admin, token, network })   (`new` is private, so one transaction)
 *   2. hub signs: token.storage_deposit({ account_id: hub, registration_only: true })   (before any deposit can arrive)
 *   3. admin signs: hub.set_settler({ account: settler, allowed: true })   (the deposit pays for the entry)
 *   4. admin signs: hub.set_checkout_key({ key, settler })   (a proposal; the deposit pays for it)
 *   5. admin signs: hub.fund_storage({ account: settler })   (prefund: the settler's storage balance, which every
 *      settle_batch, receipt key and checkout payment draws on; the hub itself never pays for storage)
 *   6. settler signs: hub.register_receipt_key({ key })   (1 yoctoNEAR; only when the settler's key is at hand,
 *      otherwise the script prints the transaction for the node operator to sign)
 *   6b. settler signs: hub.accept_checkout({ key })   (1 yoctoNEAR; the settler takes the checkout role, so no checkout
 *      payment draws on its storage balance without its consent; left to the operator like step 6 without its key)
 *   7. checks code hash, config (no pending admin), settler, checkout key and its settler (or the pending proposal when
 *      step 6b is left to the operator), token registration, the settler's storage
 *      balance and the hub's own NEAR balance
 *   8. hub signs: DeleteKey for every access key on the hub account, then checks that none is left
 *
 * Step 8 is irreversible: the hub has no upgrade method, so after it the code can never change and a bug means a new
 * hub. Function-call keys are removed too, because a key on the hub account calls the hub as itself and would pass
 * the `#[private]` check on the payout and reclaim callbacks.
 *
 * Usage (from the repository root):
 *   node packages/chain/scripts/deploy-hub.ts --network testnet --hub hub.example.testnet --admin admin.example.testnet \
 *     --token <usdc account> --settler node.example.testnet --checkout-key ed25519:... --dry-run
 *
 * Keys: PAYMINTO_HUB_KEY and PAYMINTO_ADMIN_KEY (`ed25519:...`) if set, otherwise near-cli credentials in
 * ~/.near-credentials/<network>/<account>.json (or --credentials-dir). PAYMINTO_SETTLER_KEY is optional and only
 * used for step 6. --dry-run never signs and needs no key.
 * A live testnet run also needs --confirm-lock.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { base58 } from "@scure/base";
import { InMemoryKeyStore, Near, parseKey, type KeyStore } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { acceptCheckoutTx, fundStorageTx, registerReceiptKeyTx } from "../src/actions.ts";
import { isAccountId, isId32, isPublicKey, publicKeyBytes, publicKeyToString, toHex } from "../src/bytes.ts";
import { hexToBytes } from "@noble/hashes/utils.js";
import { NearRpcError, sendBuiltOnce, sendWalletTx } from "../src/node.ts";
import { maxSettleBatchStorageCost, storageBytes, storageCost } from "../src/storage.ts";
import type { AccountId, Network } from "../src/types.ts";

export type DeployNetwork = "sandbox" | "testnet";

export type DeployOptions = {
  network: DeployNetwork;
  /** Required for sandbox. Defaults to near-kit's testnet RPC. */
  rpcUrl?: string;
  hub: AccountId;
  admin: AccountId;
  token: AccountId;
  settler: AccountId;
  /** The node's checkout public key, `ed25519:<base58>` or 64 hex characters. */
  checkoutKey: string;
  wasmPath?: string;
  /** Lower bound in yoctoNEAR for the hub's token registration; the token's `storage_balance_bounds.min` wins if higher. */
  storageDeposit?: bigint;
  /**
   * yoctoNEAR the admin puts into the settler's storage balance when it is below `minSettlerStorage`. Default 1 NEAR,
   * which pays for about 3,500 batch records of a 64-character settler: the settler pays only for its own batch records, its receipt keys and
   * checkout payments, since each Budget's owner prepays its payees' settlement storage.
   */
  settlerStorage?: bigint;
  /** The settler's storage balance the script insists on before locking. Default: the records of 100 batches. */
  minSettlerStorage?: bigint;
  /** NEAR of its own the hub account must hold beyond its storage lock and the settler's balance. Default 0.1 NEAR. */
  minHubBalance?: bigint;
  /** The key the node signs acceptances with. Defaults to the checkout key, which is the same key in a standard node. */
  receiptKey?: string;
  hubKey?: string;
  adminKey?: string;
  /** Optional. With it the script registers the receipt key itself; without it the node operator signs that step. */
  settlerKey?: string;
  credentialsDir?: string;
  dryRun?: boolean;
  /** Skip step 6. For tests that need to inspect a hub before locking it; never for a submitted hub. */
  skipLock?: boolean;
  log?: (line: string) => void;
};

export type DeployReport = {
  network: Network;
  hub: AccountId;
  wasmSha256Hex: string;
  codeHash: string;
  /**
   * Transaction hash per step, or "skipped" when the chain already showed the step done, "planned" in a dry run, or
   * "left to the settler" for the receipt key when the script has no settler key.
   */
  steps: Record<string, string>;
  locked: boolean;
  /** The settler's storage balance after the run, in yoctoNEAR, or null in a dry run that could not read it. */
  settlerStorageYocto: string | null;
  /** Whether the settler's receipt key is on the hub. `settle_own` works for this settler's sellers only once it is. */
  receiptKeyRegistered: boolean;
  /** Whether the settler accepted the checkout role. Checkout payments are refunded until it does. */
  checkoutAccepted: boolean;
};

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WASM = resolve(HERE, "../../../contracts-near/out/hub.wasm");
/**
 * The NEAR code hash (base58 of the sha256) of the committed hub v2, `contracts-near/out/hub.wasm` as built by
 * `contracts-near/build.sh`. The script refuses to deploy the default wasm when its hash is anything else; an explicit
 * `--wasm` path skips this check, for testing another build.
 */
export const HUB_CODE_HASH = "H8NHZwWQPwgdYCku8kUR7AqcnbvY28BQGaRU5LhuARFN";
/** A common NEP-141 registration price; the live run reads the token's own bound and uses the higher value. */
const DEFAULT_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const ONE_NEAR = 10n ** 24n;
const DEFAULT_SETTLER_STORAGE = ONE_NEAR;
const DEFAULT_MIN_HUB_BALANCE = ONE_NEAR / 10n;
/** Bytes of state beyond the wasm that a fresh hub writes: its root record and the account record itself. */
const HUB_STATE_MARGIN_BYTES = 2_000;
const near = (yocto: bigint) => `${(Number(yocto / 10n ** 18n) / 1e6).toFixed(6)} NEAR`;

type AccessKeys = { keys: Array<{ public_key: string; access_key: { permission: unknown } }> };

export function checkoutKeyHex(key: string): string {
  if (isId32(key)) return key;
  if (isPublicKey(key)) return toHex(publicKeyBytes(key));
  throw new Error("--checkout-key must be ed25519:<base58> or 64 lowercase hex characters");
}

type RawAccount = { amount: string; storage_usage: number; code_hash: string };

function validate(o: DeployOptions): void {
  if (o.network !== "sandbox" && o.network !== "testnet") throw new Error("--network must be sandbox or testnet; this script never targets mainnet");
  for (const [flag, v] of [["hub", o.hub], ["admin", o.admin], ["token", o.token], ["settler", o.settler]] as const) {
    if (!isAccountId(v)) throw new Error(`--${flag} must be a NEAR account id, got ${JSON.stringify(v)}`);
    if (o.network === "testnet" && v.endsWith(".near")) throw new Error(`--${flag} ${v} is a mainnet account`);
  }
  if (o.admin === o.hub) throw new Error("--admin must be a separate account from --hub (the hub refuses ADMIN_IS_HUB)");
  if (o.settler === o.hub) throw new Error("--settler must not be the hub account");
  if (o.network === "sandbox" && !o.rpcUrl) throw new Error("--rpc-url is required for sandbox");
  if (o.rpcUrl && /mainnet/i.test(o.rpcUrl)) throw new Error("--rpc-url points at mainnet");
  checkoutKeyHex(o.checkoutKey);
  if (o.receiptKey !== undefined) checkoutKeyHex(o.receiptKey);
  for (const [flag, v] of [["settler-storage", o.settlerStorage], ["min-settler-storage", o.minSettlerStorage], ["min-hub-balance", o.minHubBalance]] as const) {
    if (v !== undefined && v < 0n) throw new Error(`--${flag} must not be negative`);
  }
}

function keyStoreFor(o: DeployOptions): KeyStore {
  if (o.hubKey || o.adminKey) {
    const keys: Record<string, string> = {};
    if (o.hubKey) keys[o.hub] = o.hubKey;
    if (o.adminKey) keys[o.admin] = o.adminKey;
    if (o.settlerKey) keys[o.settler] = o.settlerKey;
    return new InMemoryKeyStore(keys);
  }
  return new FileKeyStore(o.credentialsDir ?? join(homedir(), ".near-credentials"), o.network === "sandbox" ? "localnet" : "testnet");
}

function show(signer: string, receiver: string, actions: string[]): string {
  return [`  signer:   ${signer}`, `  receiver: ${receiver}`, ...actions.map((a) => `  action:   ${a}`)].join("\n");
}

const call = (method: string, args: unknown, tgas: bigint, deposit: bigint) => `FunctionCall ${method}(${JSON.stringify(args)}) gas=${tgas} Tgas deposit=${deposit} yoctoNEAR`;

export async function deployHub(o: DeployOptions): Promise<DeployReport> {
  validate(o);
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const wasm = readFileSync(o.wasmPath ?? DEFAULT_WASM);
  const digest = createHash("sha256").update(wasm).digest();
  const network: Network = `near:${o.network}`;
  const codeHash = base58.encode(digest);
  if (o.wasmPath === undefined && codeHash !== HUB_CODE_HASH) {
    throw new Error(`${DEFAULT_WASM} has code hash ${codeHash}, not the committed hub's ${HUB_CODE_HASH}: rebuild it with sh contracts-near/build.sh, or pass --wasm to deploy another build`);
  }
  const checkoutHex = checkoutKeyHex(o.checkoutKey);
  const receiptHex = checkoutKeyHex(o.receiptKey ?? o.checkoutKey);
  const receiptKey = publicKeyToString(hexToBytes(receiptHex));
  const settlerStorage = o.settlerStorage ?? DEFAULT_SETTLER_STORAGE;
  const minSettlerStorage = o.minSettlerStorage ?? maxSettleBatchStorageCost(100);
  const minHubBalance = o.minHubBalance ?? DEFAULT_MIN_HUB_BALANCE;
  if (settlerStorage < minSettlerStorage) throw new Error(`--settler-storage ${settlerStorage} is below --min-settler-storage ${minSettlerStorage}`);
  const report: DeployReport = { network, hub: o.hub, wasmSha256Hex: digest.toString("hex"), codeHash, steps: {}, locked: false, settlerStorageYocto: null, receiptKeyRegistered: false, checkoutAccepted: false };
  const keyStore = o.dryRun ? new InMemoryKeyStore() : keyStoreFor(o);
  const client = new Near({
    network: o.rpcUrl ? { rpcUrl: o.rpcUrl, networkId: o.network === "sandbox" ? "localnet" : "testnet" } : "testnet",
    keyStore,
    retryConfig: { maxRetries: 0, initialDelayMs: 0 },
  });

  log(`${o.dryRun ? "DRY RUN: nothing is signed or sent" : "LIVE RUN"} on ${network}${o.rpcUrl ? ` (${o.rpcUrl})` : ""}`);
  log(`wasm ${o.wasmPath ?? DEFAULT_WASM}: ${wasm.length} bytes, sha256 ${report.wasmSha256Hex}, code hash ${codeHash}`);

  // Reads are best effort in a dry run, so a plan prints even with no network.
  const read = async <T>(what: string, f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (!o.dryRun) throw err;
      log(`  (could not read ${what}: ${err instanceof Error ? err.message : String(err)})`);
      return fallback;
    }
  };
  const view = <T>(contract: string, method: string, args: object) => client.view<T>(contract, method, args, { finality: "final" });
  const run = async (step: string, signer: string, receiver: string, actions: string[], done: boolean, send: () => Promise<string>) => {
    log(`\n[${step}]${done ? " already done, skipped" : ""}`);
    log(show(signer, receiver, actions));
    if (done) {
      report.steps[step] = "skipped";
      return;
    }
    if (o.dryRun) {
      report.steps[step] = "planned";
      return;
    }
    const hash = await send();
    report.steps[step] = hash;
    log(`  tx: ${hash}`);
  };

  const storageOf = async (): Promise<bigint> => BigInt((await view<string>(o.hub, "storage_of", { account: o.settler })) ?? "0");
  const receiptKeys = async (): Promise<string[]> => (await view<string[]>(o.hub, "receipt_keys", { settler: o.settler })) ?? [];
  const rawAccount = (id: string) => client.rpc.call<RawAccount>("query", { request_type: "view_account", finality: "final", account_id: id });
  /** The hub's own NEAR: its balance, less what its storage locks, less the storage balances it holds for the settler. */
  const hubOwnBalance = async (): Promise<bigint> => {
    const a = await rawAccount(o.hub);
    const held = a.code_hash === codeHash ? await storageOf() : 0n;
    return BigInt(a.amount) - storageCost(a.storage_usage) - held;
  };

  // 1. Deploy and initialize in one transaction.
  const account = await read("hub account", () => client.getAccount(o.hub, { finality: "final" }), null);
  if (account && account.codeHash !== EMPTY_CODE_HASH && account.codeHash !== codeHash) {
    throw new Error(`${o.hub} already runs other code (${account.codeHash}); deploy a new hub account instead`);
  }
  const initArgs = { admin: o.admin, token: o.token, network };
  const deployed = account?.codeHash === codeHash;

  // 0. The hub account pays for its own code and nothing else, so it needs that much NEAR before the deploy.
  const hubNeeds = storageCost(wasm.length + HUB_STATE_MARGIN_BYTES) + minHubBalance;
  log(`\n[check_hub_balance] ${o.hub} needs ${near(hubNeeds)} before the deploy: ${wasm.length + HUB_STATE_MARGIN_BYTES} bytes of storage and ${near(minHubBalance)} of its own`);
  if (!deployed) {
    const raw = await read("hub balance", () => rawAccount(o.hub), null);
    if (raw && BigInt(raw.amount) < hubNeeds) {
      const message = `${o.hub} holds ${near(BigInt(raw.amount))}, below the ${near(hubNeeds)} the deploy needs`;
      if (!o.dryRun) throw new Error(message);
      log(`  WARNING: ${message}`);
    } else if (raw) {
      log(`  ${o.hub} holds ${near(BigInt(raw.amount))}`);
    }
  }
  await run("deploy_and_init", o.hub, o.hub, [`DeployContract ${wasm.length} bytes, code hash ${codeHash}`, call("new", initArgs, 50n, 0n)], deployed, () =>
    sendBuiltOnce(client, o.hub, (b) => b.deployContract(o.hub, wasm).functionCall(o.hub, "new", initArgs, { gas: "50 Tgas", attachedDeposit: 0n }), "deploy and new"),
  );

  // 2. Register the hub at the token before any deposit can arrive.
  const bounds = await read("token storage bounds", () => view<{ min: string }>(o.token, "storage_balance_bounds", {}), { min: "0" });
  const minimum = BigInt(bounds?.min ?? "0");
  const floor = o.storageDeposit ?? DEFAULT_STORAGE_DEPOSIT;
  const storageDeposit = minimum > floor ? minimum : floor;
  const registered = (await read("hub token registration", () => view<unknown>(o.token, "storage_balance_of", { account_id: o.hub }), null)) != null;
  const regArgs = { account_id: o.hub, registration_only: true };
  await run("register_hub_at_token", o.hub, o.token, [call("storage_deposit", regArgs, 30n, storageDeposit)], registered, () =>
    sendBuiltOnce(client, o.hub, (b) => b.functionCall(o.token, "storage_deposit", regArgs, { gas: "30 Tgas", attachedDeposit: storageDeposit }), "storage_deposit"),
  );

  // 3 and 4. Admin-only setup. The deposit pays for the storage each call writes, at least one yoctoNEAR, and the
  // hub refunds what it does not use.
  const settlerSet = deployed && (await read("settler", () => view<boolean>(o.hub, "is_settler", { account: o.settler }), false)) === true;
  const settlerArgs = { account: o.settler, allowed: true };
  const settlerDeposit = storageCost(storageBytes.settler(o.settler));
  await run("set_settler", o.admin, o.hub, [call("set_settler", settlerArgs, 30n, settlerDeposit)], settlerSet, () =>
    sendBuiltOnce(client, o.admin, (b) => b.functionCall(o.hub, "set_settler", settlerArgs, { gas: "30 Tgas", attachedDeposit: settlerDeposit }), "set_settler"),
  );
  const checkoutActive = async () =>
    (await view<string | null>(o.hub, "checkout_key", {})) === checkoutHex && (await view<string | null>(o.hub, "checkout_settler", {})) === o.settler;
  const checkoutPending = async () => {
    const p = await view<{ key: string; settler: string } | null>(o.hub, "pending_checkout", {});
    return p?.key === checkoutHex && p?.settler === o.settler;
  };
  const accepted = deployed && (await read("checkout key", checkoutActive, false));
  const keySet = accepted || (deployed && (await read("pending checkout", checkoutPending, false)));
  const keyArgs = { key: checkoutHex, settler: o.settler };
  const keyDeposit = storageCost(storageBytes.checkout(o.settler));
  await run("set_checkout_key", o.admin, o.hub, [call("set_checkout_key", keyArgs, 30n, keyDeposit)], keySet, () =>
    sendBuiltOnce(client, o.admin, (b) => b.functionCall(o.hub, "set_checkout_key", keyArgs, { gas: "30 Tgas", attachedDeposit: keyDeposit }), "set_checkout_key"),
  );

  // 5. Prefund the settler's storage balance. settle_batch, receipt keys and checkout payments draw on it, and the hub
  // refuses them with INSUFFICIENT_STORAGE once it is empty. Anyone may fund it; here the admin does.
  const prepaid = deployed ? await read("settler storage balance", storageOf, 0n) : 0n;
  const prefund = fundStorageTx(o.hub, o.settler, settlerStorage);
  log(`\n[check_settler_storage] ${o.settler} holds ${near(prepaid)} of storage balance; the minimum is ${near(minSettlerStorage)} (the records of 100 batches by a 64-character settler)`);
  await run("fund_settler_storage", o.admin, o.hub, [call("fund_storage", { account: o.settler }, 30n, settlerStorage)], prepaid >= minSettlerStorage, () => sendWalletTx(client, o.admin, prefund));

  // 6. The settler's receipt key, which settle_own checks acceptances against. Only the settler can register it.
  const receiptRegistered = deployed && (await read("receipt keys", receiptKeys, [] as string[])).includes(receiptHex);
  const canSignAsSettler = o.dryRun ? false : (await keyStore.get(o.settler)) !== null;
  const receiptAction = [call("register_receipt_key", { key: receiptHex }, 30n, 1n)];
  if (receiptRegistered || canSignAsSettler) {
    await run("register_receipt_key", o.settler, o.hub, receiptAction, receiptRegistered, () => sendWalletTx(client, o.settler, registerReceiptKeyTx(o.hub, receiptKey)));
  } else {
    log(`\n[register_receipt_key] left to the settler: ${o.settler} signs this itself, with a full-access key`);
    log(show(o.settler, o.hub, receiptAction));
    log(`  Until it does, sellers cannot use settle_own for calls this node accepts.`);
    report.steps["register_receipt_key"] = o.dryRun ? "planned" : "left to the settler";
  }

  // 6b. The settler takes the checkout role. Only the settler can accept the admin's proposal, so the admin can never
  // spend the settler's storage balance on checkout payments without its consent.
  const acceptAction = [call("accept_checkout", { key: checkoutHex }, 30n, 1n)];
  if (accepted || canSignAsSettler) {
    await run("accept_checkout", o.settler, o.hub, acceptAction, accepted, () => sendWalletTx(client, o.settler, acceptCheckoutTx(o.hub, publicKeyToString(hexToBytes(checkoutHex)))));
  } else {
    log(`\n[accept_checkout] left to the settler: ${o.settler} signs this itself, with a full-access key`);
    log(show(o.settler, o.hub, acceptAction));
    log(`  Until it does, the hub refunds every checkout payment.`);
    report.steps["accept_checkout"] = o.dryRun ? "planned" : "left to the settler";
  }

  // 7. Check everything before the irreversible step.
  if (!o.dryRun) {
    const problems: string[] = [];
    const now = await client.getAccount(o.hub, { finality: "final" });
    if (now.codeHash !== codeHash) problems.push(`code hash ${now.codeHash} != ${codeHash}`);
    const config = await view<{ admin: string; pending_admin?: string | null; token: string; network: string }>(o.hub, "config", {});
    if (config?.admin !== o.admin || config?.token !== o.token || config?.network !== network) problems.push(`config ${JSON.stringify(config)}`);
    // After the lock nobody could withdraw a proposal, so an admin change someone proposed must not survive it.
    if ((config?.pending_admin ?? null) !== null) problems.push(`an admin transfer to ${config?.pending_admin} is pending`);
    if ((await view<boolean>(o.hub, "is_settler", { account: o.settler })) !== true) problems.push(`${o.settler} is not a settler`);
    report.checkoutAccepted = await checkoutActive();
    if (!report.checkoutAccepted && !(report.steps["accept_checkout"] === "left to the settler" && (await checkoutPending()))) {
      problems.push("checkout key or settler mismatch");
    }
    if ((await view<unknown>(o.token, "storage_balance_of", { account_id: o.hub })) == null) problems.push("hub is not registered at the token");
    const storage = await storageOf();
    report.settlerStorageYocto = storage.toString();
    if (storage < minSettlerStorage) problems.push(`${o.settler} holds ${near(storage)} of storage balance, below the minimum ${near(minSettlerStorage)}`);
    const own = await hubOwnBalance();
    if (own < minHubBalance) problems.push(`the hub's own balance is ${near(own)}, below the minimum ${near(minHubBalance)}`);
    report.receiptKeyRegistered = (await receiptKeys()).includes(receiptHex);
    if (problems.length) throw new Error(`refusing to lock, checks failed: ${problems.join("; ")}`);
    log(`\n[verify] code hash, config, settler, checkout key and token registration all match`);
    log(`  ${o.settler} storage balance ${near(storage)} (minimum ${near(minSettlerStorage)}); hub's own balance ${near(own)} (minimum ${near(minHubBalance)})`);
    log(`  receipt key ${receiptKey}: ${report.receiptKeyRegistered ? "registered" : "NOT registered yet; the settler must sign register_receipt_key"}`);
    log(`  checkout: ${report.checkoutAccepted ? `accepted by ${o.settler}` : `proposed; ${o.settler} must sign accept_checkout`}`);
  } else {
    log(`\n[verify] a live run checks the code hash, config, settler, checkout key and its settler, token registration,`);
    log(`  that ${o.settler} holds at least ${near(minSettlerStorage)} of storage balance, and that the hub's own balance is at least ${near(minHubBalance)}`);
  }

  // 8. Lock: remove every access key on the hub account.
  const keys = await read("hub access keys", () => client.getAccessKeys(o.hub, { finality: "final" }) as Promise<AccessKeys>, { keys: [] } as AccessKeys);
  const publicKeys = keys.keys.map((k) => k.public_key);
  if (o.skipLock) {
    log("\n[lock] skipped by option; this hub is NOT locked");
    report.steps["lock"] = "skipped";
    return report;
  }
  const lockActions = publicKeys.length
    ? publicKeys.map((pk, i) => `DeleteKey ${pk} (${describePermission(keys.keys[i]!.access_key.permission)})`)
    : o.dryRun
      ? ["DeleteKey <every access key on the hub account, listed at run time>"]
      : [];
  await run("lock", o.hub, o.hub, lockActions, !o.dryRun && publicKeys.length === 0, async () => {
    // The signing key goes last, so every earlier delete is authorized by a key that still exists.
    const signerKey = (await keyStore.get(o.hub))?.publicKey.toString();
    const ordered = [...publicKeys.filter((k) => k !== signerKey), ...publicKeys.filter((k) => k === signerKey)];
    return sendBuiltOnce(client, o.hub, (b) => ordered.reduce((acc, pk) => acc.deleteKey(o.hub, pk), b), "lock");
  });
  if (!o.dryRun) {
    const left = (await client.getAccessKeys(o.hub, { finality: "final" })) as AccessKeys;
    if (left.keys.length !== 0) throw new Error(`hub still has ${left.keys.length} access keys after locking`);
    report.locked = true;
    log("\n[locked] the hub account has no access keys; its code can never change");
  }
  return report;
}

function describePermission(p: unknown): string {
  return p === "FullAccess" ? "full access" : "function call";
}

// ---- CLI ----

function parseArgs(argv: string[]): DeployOptions & { confirmLock: boolean } {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (["dry-run", "confirm-lock"].includes(name)) bools.add(name);
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      flags.set(name, v);
    }
  }
  const need = (k: string) => {
    const v = flags.get(k);
    if (!v) throw new Error(`--${k} is required`);
    return v;
  };
  const network = need("network");
  if (network !== "sandbox" && network !== "testnet") throw new Error("--network must be sandbox or testnet");
  return {
    network,
    rpcUrl: flags.get("rpc-url"),
    hub: need("hub"),
    admin: need("admin"),
    token: need("token"),
    settler: need("settler"),
    checkoutKey: need("checkout-key"),
    wasmPath: flags.get("wasm"),
    storageDeposit: flags.has("storage-deposit") ? BigInt(flags.get("storage-deposit")!) : undefined,
    settlerStorage: flags.has("settler-storage") ? BigInt(flags.get("settler-storage")!) : undefined,
    minSettlerStorage: flags.has("min-settler-storage") ? BigInt(flags.get("min-settler-storage")!) : undefined,
    minHubBalance: flags.has("min-hub-balance") ? BigInt(flags.get("min-hub-balance")!) : undefined,
    receiptKey: flags.get("receipt-key"),
    credentialsDir: flags.get("credentials-dir"),
    hubKey: process.env["PAYMINTO_HUB_KEY"] || undefined,
    adminKey: process.env["PAYMINTO_ADMIN_KEY"] || undefined,
    settlerKey: process.env["PAYMINTO_SETTLER_KEY"] || undefined,
    dryRun: bools.has("dry-run"),
    confirmLock: bools.has("confirm-lock"),
  };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.dryRun && o.network === "testnet" && !o.confirmLock) {
    throw new Error("a live testnet run removes every key from the hub account and cannot be undone; run --dry-run first, then add --confirm-lock");
  }
  for (const k of [o.hubKey, o.adminKey, o.settlerKey]) if (k) parseKey(k);
  const report = await deployHub(o);
  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    const extra = err instanceof NearRpcError && err.txHash ? ` (tx ${err.txHash}; check it before running again)` : "";
    process.stderr.write(`deploy-hub: ${err instanceof Error ? err.message : String(err)}${extra}\n`);
    process.exit(1);
  });
}
