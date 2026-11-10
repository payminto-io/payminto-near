/**
 * The named local accounts: who they are, and how they come to exist on the sandbox.
 *
 * The demo's hub factory starts the node and deploys the token and the locked hub. Everything a person signs as in
 * the dashboard is one of the accounts below, created here by the sandbox root, each with its own fresh key that
 * exists only on this local chain.
 */
import type { DemoHub } from "@payminto/demo";
import { newNearSecretKey, publicKeyOf } from "@payminto/demo";
import type { AccountId } from "@payminto/protocol";
import { rpc } from "./signer-near.ts";

export const USDC = 1_000_000n;
const YOCTO_PER_NEAR = 10n ** 24n;

export type RoleKey = "platform" | "alice" | "bob" | "carol" | "seller" | "merchant" | "anychain" | "shopper";

export type Role = {
  key: RoleKey;
  /** One or two words for the picker. */
  role: string;
  /** What this account does in the walkthrough. */
  does: string;
  /** NEAR at creation, for gas and storage. */
  near: number;
  /** Mock USDC minted at start, in atomic units. */
  usdc: bigint;
};

export const ROLES: readonly Role[] = [
  { key: "alice", role: "Budget owner", does: "Owns the Budget of the research agent, and sells briefs that Bob's agent buys", near: 20, usdc: 500n * USDC },
  { key: "bob", role: "Budget owner", does: "Owns the Budget of the trading agent, and sells quotes that Alice's agent buys", near: 20, usdc: 500n * USDC },
  { key: "carol", role: "Budget owner, no gas", does: "Owns the Budget of the support agent and has no NEAR for gas, so she revokes through the gas relayer", near: 2, usdc: 50n * USDC },
  { key: "seller", role: "Seller", does: "Is paid for the Risk Scan and Deep Report services and owns no Budget", near: 10, usdc: 0n },
  { key: "merchant", role: "Merchant payout", does: "The payout account of the business Northwind Coffee: checkout payments are credited to it", near: 10, usdc: 0n },
  {
    key: "anychain",
    role: "Any-chain payout",
    does: "Northwind Coffee's account for payments from other chains (NEAR Intents, simulated here): the USDC lands in it directly",
    near: 5,
    usdc: 0n,
  },
  { key: "shopper", role: "Shopper", does: "Pays checkout links from a wallet", near: 10, usdc: 200n * USDC },
  { key: "platform", role: "Platform operator", does: "The treasury of whoever runs this server: it would receive platform fees under a fee plan", near: 10, usdc: 0n },
];

export type LocalAccount = Role & { accountId: AccountId; secretKey: string; publicKey: string };

export type LocalAccounts = {
  /** The sandbox root, for example test.near. */
  root: AccountId;
  list: LocalAccount[];
  by: Record<RoleKey, LocalAccount>;
  /** The node's own account. Its key is a function-call key held by the node, never by the signer. */
  settler: AccountId;
  /** The gas relayer's own account. Only the relayer service holds its key; the signer does not. */
  relayer: { accountId: AccountId; secretKey: string };
  /**
   * The simulated 1Click solver: the fake 1Click server delivers mock USDC from it with a real ft_transfer on this chain.
   * Only the stack holds its key; the signer does not.
   */
  solver: AccountId;
  /**
   * A payee that exists on chain and never registered with the token. The node's payee check warns about it (a payout
   * could not land there yet), so a call to it waits until the Budget's owner approves the payee.
   */
  vendor: AccountId;
};

/** NEAR the relayer account starts with. Its balance is the most a bug in the relayer could cost. */
const RELAYER_NEAR = 5;
/** What the simulated solver holds to deliver any-chain payments. */
export const SOLVER_USDC = 10_000n * USDC;

/**
 * Creates the accounts under the sandbox root, registers each with the token and mints its mock USDC.
 * `say` gets one line per transaction.
 */
export async function createLocalAccounts(hub: DemoHub, say: (line: string) => void): Promise<LocalAccounts> {
  if (!hub.sandbox) throw new Error("the hub factory returned no sandbox signers; local accounts need a sandbox hub");
  const { root, signers } = hub.sandbox;
  const list: LocalAccount[] = ROLES.map((r) => {
    const secretKey = newNearSecretKey();
    return { ...r, accountId: `${r.key}.${root}`, secretKey, publicKey: publicKeyOf(secretKey) };
  });
  const relayer = { accountId: `relayer.${root}`, secretKey: newNearSecretKey() };
  const vendor = `newvendor.${root}`;
  const solver = `solver.${root}`;
  say(`   Local accounts under ${root}, each with its own key that exists only on this chain:`);
  // The root signs every creation, so they go one after another: one key, one nonce at a time.
  for (const a of list) {
    const hash = await signers.built(root, `create ${a.accountId}`, (b) => b.createAccount(a.accountId).transfer(a.accountId, `${a.near} NEAR`).addKey(a.publicKey, { type: "fullAccess" }));
    signers.add(a.accountId, a.secretKey);
    say(`     tx ${hash}  ${root}: create ${a.accountId} (${a.role}) with ${a.near} NEAR`);
  }
  const hash = await signers.built(root, `create ${relayer.accountId}`, (b) => b.createAccount(relayer.accountId).transfer(relayer.accountId, `${RELAYER_NEAR} NEAR`).addKey(publicKeyOf(relayer.secretKey), { type: "fullAccess" }));
  say(`     tx ${hash}  ${root}: create ${relayer.accountId} (gas relayer) with ${RELAYER_NEAR} NEAR and a key only the relayer service holds`);
  // Its key is made and dropped: nobody signs as the new vendor here. It is deliberately not registered with the token.
  const vendorHash = await signers.built(root, `create ${vendor}`, (b) => b.createAccount(vendor).transfer(vendor, "1 NEAR").addKey(publicKeyOf(newNearSecretKey()), { type: "fullAccess" }));
  say(`     tx ${vendorHash}  ${root}: create ${vendor} (a new payee, not registered with the token, so the payee check warns about it)`);
  const solverKey = newNearSecretKey();
  const solverHash = await signers.built(root, `create ${solver}`, (b) => b.createAccount(solver).transfer(solver, "5 NEAR").addKey(publicKeyOf(solverKey), { type: "fullAccess" }));
  signers.add(solver, solverKey);
  say(`     tx ${solverHash}  ${root}: create ${solver} (the simulated 1Click solver: it delivers any-chain payments with a real ft_transfer; only the stack holds its key)`);
  // Each account signs for itself from here on, so these go in parallel. The mock token's mint registers the account;
  // an account that starts with no USDC registers with the token so payouts and payments can reach it.
  await Promise.all([...list.map((a) => (a.usdc > 0n ? hub.wallets.fund(a.accountId, a.usdc) : hub.wallets.register(a.accountId))), hub.wallets.fund(solver, SOLVER_USDC)]);
  const by = Object.fromEntries(list.map((a) => [a.key, a])) as Record<RoleKey, LocalAccount>;
  return { root, list, by, settler: hub.names.operator, relayer, vendor, solver };
}

/** An account's NEAR balance in yoctoNEAR, at final finality. */
export async function nearBalance(rpcUrl: string, account: AccountId): Promise<bigint> {
  return BigInt((await rpc<{ amount: string }>(rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: account })).amount);
}

/**
 * What the drain keeps back for its own fee: 0.00025 NEAR. The chain wants about 0.000246 NEAR up front for a plain
 * transfer and refunds most of it, so about 0.0002 NEAR is left afterwards. That is less than the up-front cost of
 * any further transaction: a second transfer, or the cheapest function call (about 0.0005 NEAR before attached gas).
 */
const DRAIN_FEE_RESERVE = (YOCTO_PER_NEAR * 25n) / 100_000n;

/**
 * Sends an account's NEAR back to the sandbox root, keeping only enough for this one transfer's fee, so the account
 * can no longer pay for a transaction of its own. This is how the walkthrough gets an owner who holds USDC and a
 * Budget but no NEAR for gas. Returns what is left, in yoctoNEAR.
 */
export async function drainNear(hub: DemoHub, rpcUrl: string, account: AccountId, say: (line: string) => void): Promise<bigint> {
  const { root, signers } = hub.sandbox!;
  const balance = await nearBalance(rpcUrl, account);
  const amount = balance - DRAIN_FEE_RESERVE;
  if (amount <= 0n) return balance;
  const hash = await signers.built(account, `drain ${account}`, (b) => b.transfer(root, `${amount} yocto`));
  const left = await nearBalance(rpcUrl, account);
  say(`     tx ${hash}  ${account}: sent its NEAR back to ${root}; ${left} yoctoNEAR are left, less than the gas of any transaction`);
  return left;
}
