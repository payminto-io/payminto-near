/**
 * The signer's key side: the local accounts' keys, near-kit to build and sign, and plain JSON-RPC to send.
 *
 * Transactions are sent with `send_tx` and returned as the RPC's own FinalExecutionOutcome, because that is what a
 * NEAR wallet hands back to a page, and the dashboard reads refunds of `ft_transfer_call` out of it.
 */
import { parseKey, type Near } from "near-kit";
import { nep413Digest, type AccountId, type WalletTx } from "@payminto/protocol";
import { SignerRefusal, type Balances, type MessageInput, type Outcome, type SignedDelegate, type SignedMessage, type SignerAccount, type SignerBackend } from "./signer.ts";

/** One account's signing material. `near` is a near-kit client whose key store holds only this account's key. */
export type KeyHolder = SignerAccount & { secretKey: string; near: Near };

const SEND_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 15_000;

type RpcError = { name?: string; message?: string; data?: unknown; cause?: { name?: string; info?: unknown } };

export async function rpc<T>(rpcUrl: string, method: string, params: unknown, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "payminto-local", method, params }), signal: ac.signal });
    if (!res.ok) throw new Error(`the local NEAR node answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: RpcError };
    if (body.error) {
      const cause = body.error.cause?.name ?? body.error.name ?? "RPC error";
      const detail = typeof body.error.data === "string" ? body.error.data : JSON.stringify(body.error.data ?? body.error.cause?.info ?? body.error.message ?? "");
      throw new Error(`${cause}: ${detail}`.slice(0, 500));
    }
    return body.result as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(`the local NEAR node did not answer ${method} within ${timeoutMs / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The chain id a node reports, for example `localnet` for near-sandbox. */
export async function chainIdOf(rpcUrl: string): Promise<string> {
  return (await rpc<{ chain_id: string }>(rpcUrl, "status", [])).chain_id;
}

export function nearBackend(o: { rpcUrl: string; token: AccountId; holders: readonly KeyHolder[] }): SignerBackend {
  const by = new Map(o.holders.map((h) => [h.accountId, h]));
  const holder = (account: AccountId): KeyHolder => {
    const h = by.get(account);
    if (!h) throw new Error(`no local key for ${account}`);
    return h;
  };
  // One transaction at a time per account: a key's nonce must go up in order.
  const queues = new Map<AccountId, Promise<unknown>>();
  const inOrder = <T>(account: AccountId, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(account) ?? Promise.resolve()).then(work, work);
    queues.set(
      account,
      next.catch(() => {}),
    );
    return next;
  };
  const builder = (h: KeyHolder, tx: WalletTx) => {
    let b = h.near.transaction(h.accountId);
    for (const a of tx.actions) b = b.functionCall(tx.receiverId, a.params.methodName, a.params.args, { gas: a.params.gas as `${number}`, attachedDeposit: BigInt(a.params.deposit) });
    return b;
  };

  return {
    rpcUrl: o.rpcUrl,
    chainId: () => chainIdOf(o.rpcUrl),
    accounts: () => o.holders.map(({ accountId, role, does, publicKey }) => ({ accountId, role, does, publicKey })),

    async balances(account): Promise<Balances> {
      const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
      const [acct, ft] = await Promise.all([
        rpc<{ amount: string }>(o.rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: account }),
        rpc<{ result: number[] }>(o.rpcUrl, "query", { request_type: "call_function", finality: "final", account_id: o.token, method_name: "ft_balance_of", args_base64: args }),
      ]);
      return { near: acct.amount, usdc: JSON.parse(Buffer.from(ft.result).toString("utf8")) as string };
    },

    signAndSend(account, tx): Promise<Outcome> {
      const h = holder(account);
      return inOrder(account, async () => {
        const signed = await builder(h, tx).sign();
        const bytes = signed.serialize();
        try {
          return await rpc<Outcome>(o.rpcUrl, "send_tx", { signed_tx_base64: Buffer.from(bytes).toString("base64"), wait_until: "FINAL" }, SEND_TIMEOUT_MS);
        } catch (err) {
          // The chain turned the transaction away before running it: the account cannot pay for the gas.
          if (err instanceof Error && /NotEnoughBalance|LackBalanceForState/.test(err.message)) {
            throw new SignerRefusal(422, "NOT_ENOUGH_NEAR", `${account} does not hold enough NEAR to pay the gas for this transaction, so the chain did not run it. Nothing was sent.`);
          }
          throw err;
        }
      });
    },

    async signMessage(account, input: MessageInput): Promise<SignedMessage> {
      const h = holder(account);
      // NEP-413: ed25519 over sha256 of the tagged Borsh payload, base64 as NEAR wallets return it.
      const digest = Buffer.from(nep413Digest({ message: input.message, recipient: input.recipient, nonce: input.nonce }), "hex");
      const signature = parseKey(h.secretKey).sign(new Uint8Array(digest));
      return { accountId: account, publicKey: h.publicKey, signature: Buffer.from(signature.data).toString("base64") };
    },

    signDelegate(account, tx, blockHeightOffset): Promise<SignedDelegate> {
      const h = holder(account);
      // NEP-366: the account signs the actions; a relayer wraps them in its own transaction and pays the gas.
      return inOrder(account, async () => {
        const out = await builder(h, tx).delegate({ receiverId: tx.receiverId, blockHeightOffset });
        const d = out.signedDelegateAction.signedDelegate.delegateAction;
        return { accountId: account, publicKey: h.publicKey, receiverId: tx.receiverId, signedDelegate: out.payload, maxBlockHeight: d.maxBlockHeight.toString(), nonce: d.nonce.toString() };
      });
    },
  };
}
