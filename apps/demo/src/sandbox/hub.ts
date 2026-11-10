/**
 * The demo's hub on a fresh near-sandbox: a local NEAR node started for this run and stopped with it.
 *
 * Setup, every step a real transaction:
 *   1. the sandbox root creates the hub, admin, token, node, owner and seller accounts, each with its own key (the
 *      lookalike account of the payee-check act is deliberately not one of them);
 *   2. the token account deploys contracts-near/out/mock_ft.wasm (a mock NEP-141 that stands in for USDC, sandbox only);
 *   3. packages/chain/scripts/deploy-hub.ts deploys contracts-near/out/hub.wasm, registers it at the token, sets the
 *      settler and checkout key, prefunds the node's storage balance, and locks the hub by deleting every key on its
 *      account;
 *   4. the node account adds to its own storage balance and registers its receipt key, through the chain package's
 *      `fundStorageTx` and `registerReceiptKeyTx` builders: the hub never pays for settlement storage, and `settle_own`
 *      takes a voucher only with an acceptance signed by a registered key;
 *   5. the node account adds a function-call key limited to `settle_batch` and `payout` on the hub, and the clearing
 *      node runs with that key through its own NearRpcChain.
 * Owners and sellers then sign their own transactions with @payminto/chain's wallet action builders.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { base58 } from "@scure/base";
import { NearRpcChain } from "@payminto/chain/node";
import { rpcReader } from "@payminto/payee-check";
import {
  acceptCheckoutTx,
  budgetIdOf,
  depositBudgetTx,
  formatAmount,
  fundFromCreditTx,
  fundStorageTx,
  openBudgetTx,
  registerReceiptKeyTx,
  revokeBudgetTx,
  settleOwnTx,
  storageDepositTx,
  type AccountId,
  type Network,
  type TxHash,
  type WalletTx,
} from "@payminto/protocol";
import type { DemoHub, HubFacts, HubNear, HubOptions } from "../chain.ts";
import { REPO_ROOT } from "../config.ts";
import { namesUnder, type DemoNames } from "../names.ts";
import { accountNear, hubAccountFacts } from "../rpc.ts";
import { newNearSecretKey, publicKeyOf, Signers } from "./near.ts";
import { resolveSandboxBinary, SANDBOX_VERSION, SandboxProcess } from "./process.ts";

const run = promisify(execFile);

export const NETWORK: Network = "near:sandbox";
export const HUB_WASM = join(REPO_ROOT, "contracts-near", "out", "hub.wasm");
export const MOCK_FT_WASM = join(REPO_ROOT, "contracts-near", "out", "mock_ft.wasm");
const DEPLOY_SCRIPT = join(REPO_ROOT, "packages", "chain", "scripts", "deploy-hub.ts");

const TGAS = 10n ** 12n;
/** Storage for a Budget record and the settle_own entries it reserves (about 0.053 NEAR); the hub refunds the rest. */
const OPEN_BUDGET_DEPOSIT = (10n ** 23n).toString();
/** What the node adds to its own storage balance at the hub, on top of the deploy script's prefund. */
const OPERATOR_STORAGE = 2n * 10n ** 24n;
const STORAGE_BYTE_COST = 10n ** 19n;

/**
 * NEAR given to each account at creation, in whole NEAR. The hub pays for its own code (about 2.9 NEAR) and nothing
 * else: settlement storage comes out of the node's prepaid storage balance.
 */
const BALANCES = { hub: 10, admin: 5, token: 30, operator: 10, owner: 10, dao: 12, seller: 5 } as const;

const codeHashOf = (wasm: Uint8Array) => base58.encode(createHash("sha256").update(wasm).digest());

export async function sandboxHub(o: HubOptions): Promise<DemoHub> {
  const say = o.say ?? (() => {});
  const tx = (hash: TxHash, signer: AccountId, what: string) => say(`     tx ${hash}  ${signer}: ${what}`);

  say(`0. SANDBOX: a fresh local NEAR node (near-sandbox ${SANDBOX_VERSION}) started for this run; nothing here reaches a public network.`);
  const binary = await resolveSandboxBinary(REPO_ROOT, say);
  const logPath = join(o.runDir, "sandbox.log");
  const sandbox = await SandboxProcess.start({ binary, logPath });
  say(`   node pid ${sandbox.pid}, RPC ${sandbox.rpcUrl} (bound to 127.0.0.1 only), log ${logPath}`);
  say(`   binary ${binary}`);
  try {
    sandbox.watch(say);
    const parent = sandbox.root.id;
    const names: DemoNames = namesUnder(parent, { hub: `hub.${parent}`, token: `usdc.${parent}`, operator: `node.${parent}` });
    const signers = new Signers(sandbox.rpcUrl);
    signers.add(parent, sandbox.root.secretKey);

    // 1. Accounts, each with its own full-access key. The DAO-style owner lives under its own parent account.
    const daoParent = names.owners.dao.slice(names.owners.dao.indexOf(".") + 1);
    const create = async (creator: AccountId, id: AccountId, near: number) => {
      const key = newNearSecretKey();
      const hash = await signers.built(creator, `create ${id}`, (b) => b.createAccount(id).transfer(id, `${near} NEAR`).addKey(publicKeyOf(key), { type: "fullAccess" }));
      signers.add(id, key);
      tx(hash, creator, `create ${id} with ${near} NEAR and its own key`);
    };
    say(`   Accounts under the sandbox root ${parent}:`);
    await Promise.all([
      create(parent, names.hub, BALANCES.hub),
      create(parent, `admin.${parent}`, BALANCES.admin),
      create(parent, names.token, BALANCES.token),
      create(parent, names.operator, BALANCES.operator),
      create(parent, names.owners.acme, BALANCES.owner),
      create(parent, names.owners.globex, BALANCES.owner),
      create(parent, names.owners.initech, BALANCES.owner),
      create(parent, daoParent, BALANCES.dao),
      create(parent, names.sellers.scans, BALANCES.seller),
      // Two more sellers, so that what the payee check says about them is a fact of this chain: `alpha` exists and
      // registers with the token later, `fresh` exists and never registers. The lookalike `mirror` is never created.
      create(parent, names.sellers.alpha, BALANCES.seller),
      create(parent, names.sellers.fresh, BALANCES.seller),
    ]);
    await create(daoParent, names.owners.dao, BALANCES.owner);

    // 2. The mock token.
    const ft = readFileSync(MOCK_FT_WASM);
    tx(
      await signers.built(names.token, "deploy mock_ft", (b) => b.deployContract(names.token, ft).functionCall(names.token, "new", {}, { gas: "30 Tgas" })),
      names.token,
      `deploy contracts-near/out/mock_ft.wasm (mock USDC, sandbox only) and call new()`,
    );

    // 3. The hub, deployed and locked by the chain package's own script, run as a separate process like an operator would.
    say(`   Hub: node packages/chain/scripts/deploy-hub.ts --network sandbox (deploy, register at the token, settler, checkout key, prefund the node's storage, lock)`);
    const admin = `admin.${parent}`;
    const deploy = await run(
      process.execPath,
      [DEPLOY_SCRIPT, "--network", "sandbox", "--rpc-url", sandbox.rpcUrl, "--hub", names.hub, "--admin", admin, "--token", names.token, "--settler", names.operator, "--checkout-key", o.checkoutKey],
      { env: { ...process.env, PAYMINTO_HUB_KEY: signers.get(names.hub).secretKey, PAYMINTO_ADMIN_KEY: signers.get(admin).secretKey }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
    ).catch((err: { stdout?: string; stderr?: string; message: string }) => {
      throw new Error(`deploy-hub.ts failed: ${err.stderr || err.message}\n${(err.stdout ?? "").slice(-2_000)}`);
    });
    const report = JSON.parse(deploy.stdout.slice(deploy.stdout.lastIndexOf("\n{\n"))) as { steps: Record<string, string>; locked: boolean; codeHash: string };
    const signerOf: Record<string, AccountId> = { deploy_and_init: names.hub, register_hub_at_token: names.hub, set_settler: admin, set_checkout_key: admin, fund_settler_storage: admin, lock: names.hub };
    // The script leaves the receipt key and accepting the checkout role to the settler, which signs both below with its
    // own key.
    for (const [step, hash] of Object.entries(report.steps)) if (signerOf[step]) tx(hash, signerOf[step], step);
    if (!report.locked) throw new Error("deploy-hub.ts did not lock the hub");

    // 4. The node prepays its settlement storage and registers the key it signs acceptances with, from its own account.
    const usdc = (a: bigint) => `${formatAmount(a)} USDC`;
    const wallet = async (signer: AccountId, t: WalletTx, what: string): Promise<TxHash> => {
      const hash = await signers.wallet(signer, t);
      tx(hash, signer, what);
      return hash;
    };
    await wallet(names.operator, fundStorageTx(names.hub, names.operator, OPERATOR_STORAGE), `fund_storage: ${Number(OPERATOR_STORAGE / 10n ** 24n)} NEAR into its own storage balance, which every settle_batch draws on`);
    await wallet(names.operator, registerReceiptKeyTx(names.hub, o.checkoutKey), `register_receipt_key ${o.checkoutKey}: settle_own takes a voucher only with an acceptance signed by it`);
    await wallet(names.operator, acceptCheckoutTx(names.hub, o.checkoutKey), `accept_checkout ${o.checkoutKey}: the node takes the checkout role the admin proposed, so checkout payments draw on its storage balance only with its consent`);

    // 5. The node's function-call key: it can call settle_batch and payout on the hub and nothing else.
    const operatorKey = newNearSecretKey();
    tx(
      await signers.built(names.operator, "add operator key", (b) =>
        b.addKey(publicKeyOf(operatorKey), { type: "functionCall", receiverId: names.hub, methodNames: ["settle_batch", "payout"], allowance: "1 NEAR" }),
      ),
      names.operator,
      `add a function-call key for ${names.hub} settle_batch and payout only; the clearing node runs with it`,
    );

    // Verifiers and checks read through a client that holds no key at all.
    const reader = new NearRpcChain({ hub: names.hub, token: names.token, network: NETWORK, rpcUrl: sandbox.rpcUrl, operator: names.operator });
    const hubWasm = readFileSync(HUB_WASM);
    const expectedCodeHash = codeHashOf(hubWasm);
    if (report.codeHash !== expectedCodeHash) throw new Error(`deploy-hub.ts deployed code hash ${report.codeHash}, expected ${expectedCodeHash}`);
    const facts = async (): Promise<HubFacts> => ({ ...(await hubAccountFacts(sandbox.rpcUrl, names.hub)), expectedCodeHash });
    const f = await facts();
    say(`   Hub ${names.hub}: code hash ${f.codeHash} (sha256 of contracts-near/out/hub.wasm), ${f.accessKeys} access keys: locked.`);

    const prepaid = await reader.storageOf(names.operator);
    const receiptKeys = await reader.receiptKeys(names.operator);
    say(`   Node ${names.operator}: ${(Number(prepaid / 10n ** 18n) / 1e6).toFixed(4)} NEAR of prepaid storage balance, receipt key ${receiptKeys.join(", ") || "MISSING"} on the hub.`);
    const near = async (): Promise<HubNear> => {
      const [account, held] = await Promise.all([accountNear(sandbox.rpcUrl, names.hub), reader.storageOf(names.operator)]);
      return { storageBytes: account.storageBytes, ownYocto: account.amountYocto - BigInt(account.storageBytes) * STORAGE_BYTE_COST - held };
    };
    let bounds: bigint | null = null;

    return {
      kind: "sandbox",
      label: `SANDBOX (a local NEAR node: near-sandbox ${SANDBOX_VERSION} on 127.0.0.1)`,
      names,
      chain: reader,
      // The node builds its own NearRpcChain from RPC_URL and OPERATOR_KEY, exactly as it does in production.
      nodeChain: undefined,
      nodeEnv: { RPC_URL: sandbox.rpcUrl, OPERATOR_KEY: operatorKey },
      rpcUrl: sandbox.rpcUrl,
      // Read-only, no key, and no indexer: a local chain has none, so account ages are not checked and verdicts say so.
      payeeReader: rpcReader(sandbox.rpcUrl),
      wallets: {
        fund: async (account, amount) => {
          const mint: WalletTx = { receiverId: names.token, actions: [{ type: "FunctionCall", params: { methodName: "mint", args: { account_id: account, amount: amount.toString() }, gas: (30n * TGAS).toString(), deposit: "0" } }] };
          await wallet(account, mint, `mint ${formatAmount(amount)} mock USDC to itself (open mint, sandbox only)`);
        },
        register: async (account) => {
          bounds ??= BigInt((await signers.view<{ min: string }>(names.token, "storage_balance_bounds", {})).min);
          await wallet(account, storageDepositTx(names.token, account, bounds.toString()), `storage_deposit at ${names.token}, so payouts can reach it`);
        },
        openBudget: async (owner, terms, escrow) => {
          const id = budgetIdOf(names.hub, NETWORK, terms);
          await wallet(owner, openBudgetTx(names.hub, terms, OPEN_BUDGET_DEPOSIT), `open_budget ${id.slice(0, 8)}... cap ${usdc(terms.cap)}`);
          if (escrow > 0n) {
            await wallet(owner, depositBudgetTx(names.token, names.hub, id, escrow), `ft_transfer_call ${usdc(escrow)} into the Budget's escrow`);
            // A refused ft_transfer_call refunds the tokens and the transaction still succeeds, so read the result.
            const b = await reader.budget(id);
            if (b?.escrow !== escrow) throw new Error(`Budget ${id} escrow is ${b?.escrow ?? "missing"} on chain, expected ${escrow}`);
          }
          return id;
        },
        settleOwn: (payee, claim, acceptance) =>
          wallet(payee, settleOwnTx(names.hub, claim, acceptance), `settle_own for Budget ${claim.budgetId.slice(0, 8)}... cumulative ${usdc(claim.cumulative)}, with the acceptance signed by ${acceptance.nodeKey.slice(0, 16)}...`),
        revokeBudget: (owner, budgetId) => wallet(owner, revokeBudgetTx(names.hub, budgetId), `revoke_budget ${budgetId.slice(0, 8)}...`),
        fundFromCredit: (owner, budgetId, amount) => wallet(owner, fundFromCreditTx(names.hub, budgetId, amount), `fund_from_credit ${usdc(amount)} into Budget ${budgetId.slice(0, 8)}...`),
      },
      solvency: async () => {
        const [balance, t] = await Promise.all([reader.balanceOf(names.hub), reader.totals()]);
        if (balance !== t.escrow + t.credits + t.inFlight) throw new Error(`solvency broken: balance ${balance} != escrow ${t.escrow} + credits ${t.credits} + in flight ${t.inFlight}`);
      },
      facts,
      near,
      stats: () => sandbox.stats(),
      sandbox: { root: parent, signers },
      close: () => sandbox.stop(),
    };
  } catch (err) {
    await sandbox.stop();
    throw err;
  }
}
