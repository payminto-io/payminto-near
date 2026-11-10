/**
 * `--chain sandbox`: real sub-accounts on the demo's local near-sandbox node.
 *
 * The hub comes from the demo's own factory (`createHub("sandbox")`), which starts near-sandbox, deploys the committed
 * hub.wasm and locks it. This file then creates `swarm.<root>` and one direct sub-account per agent, each transaction
 * built by the sub-account add-on (`createAgentAccountTx`): a buyer gets no on-chain agent key at all, a seller gets a
 * function-call key limited to the hub's payee methods, and each account's full-access key is its owner's. Every
 * account then funds and opens its own Budget with @payminto/chain's wallet action builders, signed by its own key.
 *
 * The sandbox root account and its key come from the demo's factory, which returns them as `DemoHub.sandbox`.
 */
import { generateKey, Near, parseKey, type TransactionBuilder } from "near-kit";
import { NearRpcError, sendBuiltOnce, sendWalletTx } from "@payminto/chain/node";
import type { DemoHub, DemoWallets } from "@payminto/demo";
import { budgetIdOf, depositBudgetTx, formatAmount, openBudgetTx, type AccountId, type PublicKey, type TxHash, type WalletTx } from "@payminto/protocol";
// Imported by path, not as a workspace dependency: @payminto/near-addons declares a `bin`, and pnpm marks that file
// executable for every package that depends on it, which would show up as a change in another team's package.
import * as subaccounts from "../../../packages/near-addons/src/subaccounts/index.ts";
import type { AgentSpec } from "./scenario.ts";
import { SwarmStartError } from "./world.ts";

export type RootAccount = { id: AccountId; secretKey: string };
/** What a run needs from an account's own wallet. */
export type SwarmWallets = Pick<DemoWallets, "fund" | "openBudget">;

const NEAR_YOCTO = 10n ** 24n;
const TGAS = 10n ** 12n;
/** Each agent signs a mint, open_budget (0.1 NEAR of storage, mostly refunded) and one ft_transfer_call. */
const AGENT_BALANCE = 3n * NEAR_YOCTO;
/** Storage for a Budget record and the settle_own entries it reserves; the hub refunds the rest. */
const OPEN_BUDGET_DEPOSIT = (10n ** 23n).toString();
const WRITE_TIMEOUT_MS = 60_000;

const newKey = (): { secretKey: string; publicKey: PublicKey } => {
  const secretKey = generateKey().secretKey;
  return { secretKey, publicKey: parseKey(secretKey).publicKey.toString() as PublicKey };
};

/** The root account of the sandbox the demo's hub factory started: the factory returns it as `DemoHub.sandbox`. */
export function sandboxRoot(hub: DemoHub): RootAccount {
  const s = hub.sandbox;
  if (s) return { id: s.root, secretKey: s.signers.get(s.root).secretKey };
  throw new SwarmStartError(
    "--chain sandbox needs the sandbox root account to create the agents' sub-accounts, and this hub has none.\n" +
      "What to do: start the hub with createHub(\"sandbox\") from @payminto/demo, which returns it as hub.sandbox. The simulated hub has no accounts to create; without --chain it runs the same rounds, Budgets, vouchers, settlement and proofs.",
  );
}

/** Applies the add-on's wallet-shaped actions to a near-kit transaction builder. */
export function applyAccountTx(b: TransactionBuilder, tx: subaccounts.AccountTx): TransactionBuilder {
  let out = b;
  for (const a of tx.actions) {
    if (a.type === "CreateAccount") out = out.createAccount(tx.receiverId);
    else if (a.type === "Transfer") out = out.transfer(tx.receiverId, BigInt(a.params.deposit));
    else if (a.type === "AddKey") {
      const p = a.params.accessKey.permission;
      if (p === "FullAccess") out = out.addKey(a.params.publicKey, { type: "fullAccess" });
      else {
        // The add-on's function-call permission carries the receiver, the methods and the key's gas budget in yoctoNEAR.
        const { receiverId, methodNames, ...gasBudget } = p;
        const budget = Object.fromEntries(Object.entries(gasBudget).map(([k, v]) => [k, BigInt(String(v))]));
        out = out.addKey(a.params.publicKey, { type: "functionCall", receiverId, methodNames: methodNames ?? [], ...budget } as never);
      }
    } else if (a.type === "DeleteKey") out = out.deleteKey(tx.receiverId, a.params.publicKey);
    else out = out.functionCall(tx.receiverId, a.params.methodName, a.params.args, { gas: a.params.gas as `${number}`, attachedDeposit: BigInt(a.params.deposit) });
  }
  return out;
}

/**
 * Transactions from one key sent together can reach the node out of nonce order, and the later nonce then makes the
 * earlier one invalid. Such a transaction never executed, so signing it again with a fresh nonce is safe.
 */
async function retryNonce<T>(send: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await send();
    } catch (err) {
      const nonce = err instanceof NearRpcError && err.kind === "rejected" && /nonce/i.test(err.message);
      if (!nonce || i >= attempts) throw err;
    }
  }
}

/**
 * Creates the parent account and every agent's sub-account, and returns the wallet actions those accounts sign
 * themselves. `width` accounts are created at a time.
 */
export async function createSwarmAccounts(hub: DemoHub, parent: AccountId, agents: readonly AgentSpec[], say: (line: string) => void, width = 5): Promise<SwarmWallets> {
  const rpcUrl = hub.rpcUrl;
  if (!rpcUrl) throw new SwarmStartError("--chain sandbox needs a hub with an RPC URL; the simulated hub has none. Run without --chain, or check apps/demo's sandbox hub.");
  const root = sandboxRoot(hub);
  const clients = new Map<AccountId, Near>();
  const add = (id: AccountId, secretKey: string) => void clients.set(id, new Near({ network: { rpcUrl, networkId: "localnet" }, keyStore: { [id]: secretKey }, retryConfig: { maxRetries: 0, initialDelayMs: 0 } }));
  const clientOf = (id: AccountId): Near => {
    const c = clients.get(id);
    if (!c) throw new Error(`no key for ${id} in this sandbox run`);
    return c;
  };
  const built = (signer: AccountId, label: string, build: (b: TransactionBuilder) => TransactionBuilder): Promise<TxHash> => retryNonce(() => sendBuiltOnce(clientOf(signer), signer, build, label, WRITE_TIMEOUT_MS));
  const wallet = (signer: AccountId, tx: WalletTx): Promise<TxHash> => retryNonce(() => sendWalletTx(clientOf(signer), signer, tx, WRITE_TIMEOUT_MS));
  const tx = (hash: TxHash, signer: AccountId, what: string) => say(`     tx ${hash}  ${signer}: ${what}`);
  add(root.id, root.secretKey);

  // The parent holds the NEAR its sub-accounts start with. Only the parent can create its direct sub-accounts.
  say(`   Sub-accounts: ${root.id} creates ${parent}, and ${parent} creates one account per agent with the sub-account add-on's builder.`);
  const parentKey = newKey();
  const funding = AGENT_BALANCE * BigInt(agents.length) + 10n * NEAR_YOCTO;
  tx(await built(root.id, `create ${parent}`, (b) => b.createAccount(parent).transfer(parent, funding).addKey(parentKey.publicKey, { type: "fullAccess" })), root.id, `create ${parent}, the parent of every agent`);
  add(parent, parentKey.secretKey);

  const create = async (a: AgentSpec) => {
    const ownerKey = newKey();
    // A seller's on-chain agent key may only call settle_own and payout on the hub. A buyer has none: it pays with vouchers.
    const onchainAgentKey = a.role === "seller" ? newKey() : null;
    const made = subaccounts.createAgentAccountTx({
      owner: parent,
      label: a.account.slice(0, a.account.indexOf(".")),
      hub: hub.names.hub,
      role: a.role,
      ownerPublicKey: ownerKey.publicKey,
      ...(onchainAgentKey ? { agentPublicKey: onchainAgentKey.publicKey } : {}),
      initialBalance: AGENT_BALANCE.toString(),
    });
    if (made.accountId !== a.account) throw new Error(`the add-on named the account ${made.accountId}, the scenario expects ${a.account}`);
    const hash = await built(parent, `create ${made.accountId}`, (b) => applyAccountTx(b, made.tx));
    // The account's own full-access key signs its mint, open_budget and escrow deposit; the voucher key never goes on chain.
    add(made.accountId, ownerKey.secretKey);
    tx(hash, parent, `create ${made.accountId}${onchainAgentKey ? " with an agent key limited to settle_own and payout on the hub" : " with no on-chain agent key"}`);
  };
  for (let i = 0; i < agents.length; i += width) await Promise.all(agents.slice(i, i + width).map(create));

  const usdc = (a: bigint) => `${formatAmount(a)} USDC`;
  const { hub: hubAccount, token } = hub.names;
  return {
    fund: async (account, amount) => {
      const mint: WalletTx = { receiverId: token, actions: [{ type: "FunctionCall", params: { methodName: "mint", args: { account_id: account, amount: amount.toString() }, gas: (30n * TGAS).toString(), deposit: "0" } }] };
      tx(await wallet(account, mint), account, `mint ${formatAmount(amount)} mock USDC to itself (open mint, sandbox only)`);
    },
    openBudget: async (owner, terms, escrow) => {
      const id = budgetIdOf(hubAccount, hub.chain.network, terms);
      tx(await wallet(owner, openBudgetTx(hubAccount, terms, OPEN_BUDGET_DEPOSIT)), owner, `open_budget ${id.slice(0, 8)}... cap ${usdc(terms.cap)}`);
      if (escrow > 0n) {
        tx(await wallet(owner, depositBudgetTx(token, hubAccount, id, escrow)), owner, `ft_transfer_call ${usdc(escrow)} into the Budget's escrow`);
        // A refused ft_transfer_call refunds the tokens and the transaction still succeeds, so read the result.
        const b = await hub.chain.budget(id);
        if (b?.escrow !== escrow) throw new Error(`Budget ${id} escrow is ${b?.escrow ?? "missing"} on chain, expected ${escrow}`);
      }
      return id;
    },
  };
}
