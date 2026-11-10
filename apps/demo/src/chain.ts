import { FakeChain } from "@payminto/chain/fake";
import type { NearReader } from "@payminto/payee-check";
import { FakeNearReader } from "@payminto/payee-check/fake";
import type { Acceptance, AccountId, BudgetTerms, Chain, Claim, Id32, Network, PublicKey, TxHash } from "@payminto/protocol";
import type { ChainKind } from "./config.ts";
import { FAKE_NAMES, type DemoNames } from "./names.ts";
import { freePort } from "./ports.ts";
import type { SandboxStats } from "./sandbox/process.ts";
import { newNearSecretKey, type Signers } from "./sandbox/near.ts";

/** Kept for code written against the simulated stack; a run's own names are `DemoHub.names`. */
export const HUB: AccountId = FAKE_NAMES.hub;
export const TOKEN: AccountId = FAKE_NAMES.token;
export const OPERATOR: AccountId = FAKE_NAMES.operator;
export const NETWORK: Network = "near:sandbox";

/**
 * What the owners and sellers in the story do from their own wallets. On a real chain each of these is a transaction
 * the account signs; the node never holds those keys.
 */
export interface DemoWallets {
  /** Test tokens for an account. */
  fund(account: AccountId, amount: bigint): Promise<void>;
  /** NEP-145 registration at the token, so the account can receive payouts. */
  register(account: AccountId): Promise<void>;
  /** `open_budget` signed by the owner, then `ft_transfer_call` into escrow. */
  openBudget(owner: AccountId, terms: BudgetTerms, escrow: bigint): Promise<Id32>;
  /** `settle_own` signed by the payee, with the node's acceptance of that call: the escape hatch when the node is gone. */
  settleOwn(payee: AccountId, claim: Claim, acceptance: Acceptance): Promise<TxHash>;
  /** `revoke_budget` signed by the owner. */
  revokeBudget(owner: AccountId, budgetId: Id32): Promise<TxHash>;
  /** `fund_from_credit` signed by the owner: earned hub credit becomes escrow of the owner's own Budget. */
  fundFromCredit(owner: AccountId, budgetId: Id32, amount: bigint): Promise<TxHash>;
}

/** What the hub account itself shows on chain. Null on the simulated hub, which has no accounts or code. */
export type HubFacts = { accessKeys: number; codeHash: string; expectedCodeHash: string };

/**
 * The hub account's NEAR side: the bytes of storage it uses, and its own balance, which is its NEAR less what that
 * storage locks and less the storage balance it holds for the node. The Budgets' storage reserves are NEAR their owners
 * prepaid, so a batch that draws on them lowers `ownYocto` by exactly the bytes it takes; anything more, the hub paid.
 */
export type HubNear = { storageBytes: number; ownYocto: bigint };

/** The chain one demo run uses. */
export type DemoHub = {
  kind: ChainKind;
  /** Printed wherever chain state is shown, so simulated data is never mistaken for NEAR. */
  label: string;
  names: DemoNames;
  /** The read side: what the story's verifiers and the checks read. On sandbox it holds no key at all. */
  chain: Chain;
  /** Handed to the node. Undefined means the node builds its own NearRpcChain from `nodeEnv`, as in production. */
  nodeChain: Chain | undefined;
  /** Extra node configuration, for example RPC_URL and OPERATOR_KEY. */
  nodeEnv: Record<string, string>;
  /** The JSON-RPC a verifier uses, or null for the simulated hub. */
  rpcUrl: string | null;
  /**
   * What the payee check reads accounts with. On sandbox it is the package's read-only RPC reader on the sandbox's own
   * endpoint, so every signal is a fact of that chain. On the simulated hub it is the package's fake reader, kept in
   * step with what the story's wallets do there.
   */
  payeeReader: NearReader;
  wallets: DemoWallets;
  /** The hub's solvency invariant: token balance equals escrow plus credits plus in-flight payouts. Throws if broken. */
  solvency(): Promise<void>;
  facts(): Promise<HubFacts | null>;
  /** Null on the simulated hub, which has no NEAR accounts. */
  near(): Promise<HubNear | null>;
  /** Block production while the story ran, or null for the simulated hub. */
  stats(): SandboxStats | null;
  /**
   * Sandbox only: the sandbox root account and the key holders of this run, so a caller can create more local accounts
   * (the swarm creates its agents' sub-accounts with the root's key, `signers.get(root).secretKey`).
   */
  sandbox?: { root: AccountId; signers: Signers };
  close(): Promise<void>;
};

export type HubOptions = {
  /** The run's disposable directory: the sandbox log goes here. */
  runDir: string;
  /** The node's acceptance and checkout public key: the hub's checkout key, and the receipt key the node registers. */
  checkoutKey: PublicKey;
  say?: (line: string) => void;
};

/**
 * The simulated hub: an in-memory model of the contract with the same rules and refusal codes. `receiptKey` is the key
 * the node signs acceptances with; the node's account registers it, as on a real hub, so sellers can use `settle_own`.
 */
export function fakeHub(receiptKey?: PublicKey): DemoHub {
  const names = FAKE_NAMES;
  const chain = new FakeChain({ hub: names.hub, token: names.token, network: NETWORK, operator: names.operator });
  // The settler is allowlisted with its settlement storage prepaid, then registers its receipt key.
  chain.addSettler(names.operator);
  if (receiptKey) void chain.registerReceiptKey(names.operator, receiptKey);
  // The accounts the payee check can see. Every owner and seller exists, each with its own key, and none is registered
  // with the token until its wallet mints or registers below. The lookalike `mirror` does not exist, as on the sandbox.
  const payeeReader = new FakeNearReader({ [names.token]: { codeHash: "simulated-token-code", fullAccessKeys: 0 }, [names.hub]: { codeHash: "simulated-hub-code", fullAccessKeys: 0, registeredWith: [names.token] } });
  const { mirror, ...sellers } = names.sellers;
  for (const account of new Set([names.operator, ...Object.values(names.owners), ...Object.values(sellers)])) payeeReader.set(account, {});
  payeeReader.accounts.delete(mirror);
  const registered = (account: AccountId) => void payeeReader.set(account, { ...payeeReader.accounts.get(account), registeredWith: [names.token] });
  return {
    kind: "fake",
    label: "SIMULATED (in-memory model of the hub, not NEAR)",
    names,
    chain,
    nodeChain: chain,
    // Never used: the simulated hub signs nothing. The node still requires a well-formed key.
    nodeEnv: { OPERATOR_KEY: newNearSecretKey() },
    rpcUrl: null,
    payeeReader,
    wallets: {
      fund: async (account, amount) => {
        chain.mint(account, amount);
        registered(account);
      },
      register: async (account) => {
        chain.register(account);
        registered(account);
      },
      openBudget: async (owner, terms, escrow) => {
        const id = chain.openBudget(owner, terms);
        if (escrow > 0n) chain.depositBudget(owner, id, escrow);
        return id;
      },
      settleOwn: (payee, claim, acceptance) => chain.settleOwn(payee, claim, acceptance),
      revokeBudget: (owner, id) => chain.revokeBudget(owner, id),
      fundFromCredit: (owner, id, amount) => chain.fundFromCredit(owner, id, amount),
    },
    solvency: async () => chain.solvency(),
    facts: async () => null,
    near: async () => null,
    stats: () => null,
    close: async () => {},
  };
}

export async function createHub(kind: ChainKind, opts?: HubOptions): Promise<DemoHub> {
  if (kind === "fake") return fakeHub(opts?.checkoutKey);
  if (!opts) throw new Error("a sandbox hub needs a run directory and the node's checkout key");
  const { sandboxHub } = await import("./sandbox/hub.ts");
  return sandboxHub(opts);
}

export { freePort };
