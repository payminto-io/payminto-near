/**
 * The agent desk: it holds the agent keys of the local stack and makes paid calls with the real SDK `AgentClient`.
 *
 * An agent key is a bare ed25519 key with no NEAR account and no funds. A Budget names its public half; whoever holds
 * the secret half can spend within that Budget's rules and nothing else. In production the key lives in the agent's
 * own runtime. Here the desk plays that runtime, so a person can make an agent call from a browser.
 */
import { randomBytes } from "node:crypto";
import { keypairFromSeed, type AccountId, type Id32, type Keypair, type Network, type PublicKey } from "@payminto/protocol";
import { AgentClient, PayFailed, type PaymentOutcome } from "@payminto/sdk";
import { assertLocalDatabase } from "./data.ts";

export type DeskKey = { name: string; keypair: Keypair };

export type CallResult =
  | { ok: true; url: string; status: number; priceAtomic: string; callId: Id32; body: unknown }
  | {
      ok: false;
      url: string;
      refused: true;
      rule: string;
      message: string;
      attemptedAmount: string | null;
      remainingBudget: string | null;
      retry: unknown;
      /** "agent": the SDK's own guard refused and signed nothing. "node": a voucher was sent and the node refused it. */
      by: "node" | "agent";
    }
  | { ok: false; url: string; refused: false; status: number; message: string };

export type DeskOptions = {
  nodeUrl: string;
  network: Network;
  hub: AccountId;
  /** The node's receipt key, pinned so a receipt signed by anything else is refused. */
  nodeKey: PublicKey;
  /** Where the receipt store of one Budget goes. The path must be a `*.demo.db` in the local data directory. */
  storePath: (name: string) => string;
};

export class AgentDesk {
  readonly #o: DeskOptions;
  readonly #keys = new Map<PublicKey, DeskKey>();
  /** One client per (Budget, guard) pair; both share the Budget's receipt store, as the SDK requires for one key. */
  readonly #clients = new Map<string, AgentClient>();
  readonly #stores = new Map<Id32, AgentClient>();
  readonly #queues = new Map<Id32, Promise<unknown>>();

  constructor(o: DeskOptions) {
    this.#o = o;
  }

  /** A fresh agent key under a name. Only the public half ever leaves this process. */
  newKey(name: string): DeskKey {
    const k = { name, keypair: keypairFromSeed(new Uint8Array(randomBytes(32))) };
    this.#keys.set(k.keypair.publicKey, k);
    return k;
  }

  keys(): DeskKey[] {
    return [...this.#keys.values()];
  }

  holds(agentPk: string): boolean {
    return this.#keys.has(agentPk as PublicKey);
  }

  #client(budgetId: Id32, agentPk: PublicKey, guard: boolean): AgentClient {
    const id = `${budgetId}:${guard ? "guarded" : "unguarded"}`;
    let c = this.#clients.get(id);
    if (c) return c;
    const key = this.#keys.get(agentPk);
    if (!key) throw new Error(`the agent desk holds no key ${agentPk}`);
    const common = { network: this.#o.network, hub: this.#o.hub, nodeUrl: this.#o.nodeUrl, trustedNodeKey: this.#o.nodeKey, keypair: key.keypair, budgetId, enforcePolicy: guard };
    const owner = this.#stores.get(budgetId);
    if (owner) c = new AgentClient({ ...common, receipts: owner.receipts });
    else {
      const storePath = this.#o.storePath(`agent-${budgetId.slice(0, 12)}`);
      assertLocalDatabase(storePath);
      c = new AgentClient({ ...common, storePath });
      this.#stores.set(budgetId, c);
    }
    this.#clients.set(id, c);
    return c;
  }

  /**
   * One paid call from a Budget. With `guard` on, the SDK checks the Budget's rules before it signs, as a healthy
   * agent does. With it off, the voucher is signed regardless, which is what a compromised agent runtime would do, and
   * the node is then the one that refuses and records the refusal.
   */
  call(o: { budgetId: Id32; agentPk: PublicKey; url: string; guard: boolean }): Promise<CallResult> {
    const work = async (): Promise<CallResult> => {
      const client = this.#client(o.budgetId, o.agentPk, o.guard);
      let response: Response;
      let payment: PaymentOutcome;
      try {
        ({ response, payment } = await client.pay(o.url));
      } catch (err) {
        if (!(err instanceof PayFailed)) throw err;
        const unknown = err.payment.status === "unverified" ? " A voucher had already left the agent, so this call may still have been paid." : "";
        return { ok: false, url: o.url, refused: false, status: 0, message: `${err.message}.${unknown}` };
      }
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: keep the text.
      }
      const r = payment.refusal;
      if (r) {
        return {
          ok: false,
          url: o.url,
          refused: true,
          rule: r.refusal?.rule ?? r.code,
          message: r.refusal?.message ?? r.message,
          attemptedAmount: r.refusal?.attemptedAmount ?? null,
          remainingBudget: r.refusal?.remainingBudget ?? null,
          retry: r.refusal?.retry ?? null,
          // The SDK names the seller as the source, because the seller relays the answer. Here the seller is this
          // stack's own paywall in front of this stack's own node, so the refusal is the node's.
          by: r.source === "agent" ? "agent" : "node",
        };
      }
      const voucher = payment.vouchers.find((v) => v.state === "paid");
      if (response.ok && payment.status === "paid" && voucher) return { ok: true, url: o.url, status: response.status, priceAtomic: payment.paid.toString(), callId: voucher.callId, body };
      const why = payment.status === "unverified" ? "a voucher was sent and its outcome is not known" : typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
      return { ok: false, url: o.url, refused: false, status: response.status, message: why };
    };
    // One call at a time per Budget, so vouchers of one key go out in order.
    const next = (this.#queues.get(o.budgetId) ?? Promise.resolve()).then(work, work);
    this.#queues.set(
      o.budgetId,
      next.catch(() => {}),
    );
    return next;
  }

  close(): void {
    for (const c of this.#stores.values()) c.close();
    this.#clients.clear();
    this.#stores.clear();
  }
}
