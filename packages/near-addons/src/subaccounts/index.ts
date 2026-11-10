import { isAccountId, isPublicKey, storageDepositTx, type AccountId, type FunctionCallAction, type PublicKey, type WalletTx } from "@payminto/chain";

/**
 * Wallet actions beyond function calls, in the shape `@near-wallet-selector/core` defines in
 * `packages/core/src/lib/wallet/transactions.types.ts` (`CreateAccount`, `Transfer`, `AddKey`, `DeleteKey`).
 */
export type AddKeyPermission = "FullAccess" | { receiverId: AccountId; allowance?: string; methodNames?: string[] };
export type AccountAction =
  | FunctionCallAction
  | { type: "CreateAccount" }
  | { type: "Transfer"; params: { deposit: string } }
  | { type: "AddKey"; params: { publicKey: PublicKey; accessKey: { nonce?: number; permission: AddKeyPermission } } }
  | { type: "DeleteKey"; params: { publicKey: PublicKey } };
export type AccountTx = { receiverId: AccountId; actions: AccountAction[] };

/**
 * What an agent calls on the hub, by role. A buyer agent pays with off-chain vouchers signed by a bare ed25519 key named
 * in the Budget terms, so it calls nothing on chain and needs no access key at all. A selling agent is a payee: it may
 * call `settle_own`, the escape hatch, and `payout`, which anyone may call. `fund_from_credit` is left out on purpose:
 * it needs 1 yoctoNEAR, and function-call keys cannot attach a deposit, which is how the hub keeps credit out of reach
 * of agent keys.
 */
export const AGENT_HUB_METHODS = {
  buyer: [] as const,
  seller: ["settle_own", "payout"] as const,
} as const;
export type AgentRole = keyof typeof AGENT_HUB_METHODS;

/** 0.25 NEAR of gas allowance for a seller key: many `settle_own` or `payout` calls, and a bounded loss if the key leaks. */
export const DEFAULT_SELLER_ALLOWANCE = "250000000000000000000000";
/** 0.05 NEAR: the new account's storage and some gas for a seller key. */
export const DEFAULT_INITIAL_BALANCE = "50000000000000000000000";

/**
 * `<label>.<owner>`. Only the parent account can create its direct sub-accounts, so the label is one segment and the
 * owner must be a named account (an implicit 64-hex account has no sub-accounts).
 */
export function agentAccountId(label: string, owner: AccountId): AccountId {
  if (!/^(?:[a-z0-9]+[-_])*[a-z0-9]+$/.test(label)) throw new Error("label must be one account-id segment: lowercase letters, digits, single - or _");
  if (!isAccountId(owner)) throw new Error("owner must be a NEAR account id");
  if (/^[0-9a-f]{64}$/.test(owner) || /^0x[0-9a-f]{40}$/.test(owner)) throw new Error("an implicit account cannot have sub-accounts");
  const id = `${label}.${owner}`;
  if (!isAccountId(id)) throw new Error(`${id} is not a valid account id (at most 64 characters)`);
  return id;
}

export type CreateAgentAccount = {
  owner: AccountId;
  label: string;
  hub: AccountId;
  role: AgentRole;
  /**
   * The owner's own public key, added as the sub-account's only full-access key. The owner keeps it offline. It is the
   * only way to move tokens paid out to the sub-account, to rotate the agent key, or to delete the account.
   */
  ownerPublicKey: PublicKey;
  /** The agent's on-chain key, required for a seller and refused for a buyer. Never the voucher key. */
  agentPublicKey?: PublicKey;
  initialBalance?: string;
  allowance?: string;
};

const yocto = (v: string, what: string): string => {
  if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`${what} must be a yoctoNEAR decimal string`);
  return v;
};

/** The function-call key permission for an agent role on the hub, or null for a role that calls nothing. */
export function agentKeyPermission(hub: AccountId, role: AgentRole, allowance: string = DEFAULT_SELLER_ALLOWANCE): AddKeyPermission | null {
  const methods = AGENT_HUB_METHODS[role];
  if (methods.length === 0) return null;
  if (!isAccountId(hub)) throw new Error("hub must be a NEAR account id");
  // A zero allowance in an AddKey action is a zero gas budget, not unlimited, so it would make the key useless.
  if (yocto(allowance, "allowance") === "0") throw new Error("allowance must be positive");
  return { receiverId: hub, allowance, methodNames: [...methods] };
}

/**
 * The one transaction the owner signs to create `<label>.<owner>`: CreateAccount, Transfer, the owner's full-access key,
 * and for a seller the agent's function-call key limited to the hub's payee methods. The agent never holds a
 * full-access key.
 */
export function createAgentAccountTx(p: CreateAgentAccount): { accountId: AccountId; tx: AccountTx } {
  const accountId = agentAccountId(p.label, p.owner);
  if (!isPublicKey(p.ownerPublicKey)) throw new Error("ownerPublicKey must be an ed25519 public key");
  const permission = agentKeyPermission(p.hub, p.role, p.allowance);
  if (permission === null && p.agentPublicKey !== undefined) throw new Error(`a ${p.role} agent calls nothing on chain, so it gets no access key`);
  if (permission !== null && !isPublicKey(p.agentPublicKey)) throw new Error(`a ${p.role} agent needs agentPublicKey`);
  if (p.agentPublicKey !== undefined && p.agentPublicKey === p.ownerPublicKey) throw new Error("the agent key must differ from the owner key");
  const actions: AccountAction[] = [
    { type: "CreateAccount" },
    { type: "Transfer", params: { deposit: yocto(p.initialBalance ?? DEFAULT_INITIAL_BALANCE, "initialBalance") } },
    { type: "AddKey", params: { publicKey: p.ownerPublicKey, accessKey: { nonce: 0, permission: "FullAccess" } } },
  ];
  if (permission !== null && p.agentPublicKey) actions.push({ type: "AddKey", params: { publicKey: p.agentPublicKey, accessKey: { nonce: 0, permission } } });
  return { accountId, tx: { receiverId: accountId, actions } };
}

/**
 * NEP-145 registration of the agent account at the settlement token, paid by the owner, so `payout` can deliver to it.
 * The hub never pays registration, and an unregistered payee keeps its credit until it is registered.
 */
export const registerAgentAtTokenTx = (token: AccountId, agent: AccountId, deposit: string): WalletTx => storageDepositTx(token, agent, yocto(deposit, "deposit"));

/** Rotates the agent key: add the new function-call key and delete the old one, signed by the owner's full-access key on the agent account. */
export function rotateAgentKeyTx(agent: AccountId, hub: AccountId, oldKey: PublicKey, newKey: PublicKey, allowance: string = DEFAULT_SELLER_ALLOWANCE): AccountTx {
  if (!isPublicKey(oldKey) || !isPublicKey(newKey) || oldKey === newKey) throw new Error("need two different ed25519 public keys");
  const permission = agentKeyPermission(hub, "seller", allowance)!;
  return {
    receiverId: agent,
    actions: [
      { type: "AddKey", params: { publicKey: newKey, accessKey: { nonce: 0, permission } } },
      { type: "DeleteKey", params: { publicKey: oldKey } },
    ],
  };
}

/** Removes the agent's on-chain key entirely, for example when an agent is retired. Signed by the owner key on the agent account. */
export const revokeAgentKeyTx = (agent: AccountId, key: PublicKey): AccountTx => ({ receiverId: agent, actions: [{ type: "DeleteKey", params: { publicKey: key } }] });

/** Checks a key permission read with `view_access_key` against what the role allows. Returns problems; empty means it matches. */
export function auditAgentKey(permission: unknown, hub: AccountId, role: AgentRole): string[] {
  if (permission === "FullAccess") return ["the agent key is a full-access key"];
  const fc = (permission as { FunctionCall?: { receiver_id?: string; method_names?: string[]; allowance?: string | null } } | null)?.FunctionCall;
  if (!fc) return ["not a function-call key"];
  const problems: string[] = [];
  if (fc.receiver_id !== hub) problems.push(`key calls ${fc.receiver_id}, expected ${hub}`);
  const allowed = new Set<string>(AGENT_HUB_METHODS[role]);
  const methods = fc.method_names ?? [];
  if (methods.length === 0) problems.push("key may call every method on the hub");
  for (const m of methods) if (!allowed.has(m)) problems.push(`key may call ${m}, which a ${role} agent does not need`);
  if (fc.allowance === null || fc.allowance === undefined) problems.push("key has unlimited gas allowance");
  return problems;
}
