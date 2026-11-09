import { BaseError, erc20Abi, getAddress, InvalidParamsRpcError, type Address, type Hex } from "viem";
import type { ChainClient } from "../chain.ts";
import type { Database } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import type { CreditRow, PaymentRow } from "./model.ts";
import type { PaymentService } from "./payments.ts";

/** eth_getLogs block range limit on HashKey Chain RPCs. */
export const MAX_LOG_RANGE = 5_000n;
/** Forwarders per eth_getLogs topic filter. */
const ADDRESS_CHUNK = 200;
const CURSOR = "deposits";

export type TransferLog = { txHash: Hex; logIndex: number; blockNumber: bigint; blockHash: Hex; from: Address; to: Address; value: bigint };

/** Where deposit Transfer logs come from: the chain in production, a scripted fake in the reorg unit test. */
export interface TransferSource {
  /** The latest block and the block at the node's finality tag (CONFIRM_TAG). */
  heads(): Promise<{ latest: bigint; final: bigint }>;
  transfersTo(to: readonly Address[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
}

export function chainTransferSource(chain: ChainClient): TransferSource {
  const transfer = erc20Abi.find((x) => x.type === "event" && x.name === "Transfer") as Extract<(typeof erc20Abi)[number], { type: "event"; name: "Transfer" }>;
  return {
    async heads() {
      const [latest, final] = await Promise.all([chain.public.getBlockNumber({ cacheTime: 0 }), chain.headOf()]);
      return { latest, final: final < latest ? final : latest };
    },
    async transfersTo(to, fromBlock, toBlock) {
      const logs = await chain.public.getLogs({ address: chain.token, event: transfer, args: { to: [...to] }, fromBlock, toBlock });
      return logs
        .filter((l) => !l.removed)
        .map((l) => ({
          txHash: l.transactionHash,
          logIndex: Number(l.logIndex),
          blockNumber: l.blockNumber,
          blockHash: l.blockHash,
          from: getAddress(l.args.from!),
          to: getAddress(l.args.to!),
          value: l.args.value!,
        }));
    },
  };
}

const keyOf = (txHash: string, logIndex: number) => `${txHash.toLowerCase()}:${logIndex}`;

/**
 * Deposit watcher (GATEWAY.md section 4). The cursor only ever stands at the finality head. Each tick:
 * 1. scans (cursor, final] in chunks of at most 5,000 blocks, confirming what it finds and dropping pending credits in
 *    that range that are gone (reorged out before finality), committing the cursor per chunk;
 * 2. rescans (final, latest], the unconfirmed tail, recording pending credits and dropping pending ones it no longer sees.
 * Every pending deposit credit lies above the cursor, so every tick re-proves it against the canonical chain.
 */
export class DepositWatcher {
  readonly #db: Database;
  readonly #payments: PaymentService;
  readonly #source: TransferSource;
  readonly #startBlock: bigint;
  readonly #log: Logger;
  #busy: Promise<void> | null = null;

  constructor(o: { db: Database; payments: PaymentService; source: TransferSource; startBlock: bigint; log: Logger }) {
    this.#db = o.db;
    this.#payments = o.payments;
    this.#source = o.source;
    this.#startBlock = o.startBlock;
    this.#log = o.log;
  }

  cursor(): bigint {
    const r = this.#db.get<{ block: number }>("SELECT block FROM gateway_cursors WHERE name = ?", CURSOR);
    return r ? BigInt(r.block) : this.#startBlock - 1n;
  }

  #setCursor(b: bigint) {
    this.#db.run("INSERT INTO gateway_cursors (name, block) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET block = excluded.block", CURSOR, Number(b));
  }

  tick(): Promise<void> {
    this.#busy ??= this.#run().finally(() => {
      this.#busy = null;
    });
    return this.#busy;
  }

  async #scan(watched: Map<string, PaymentRow>, from: bigint, to: bigint): Promise<TransferLog[]> {
    // Every watched forwarder (the map keys), including those of a payment's earlier quotes.
    const addresses = [...watched.keys()].map((a) => getAddress(a));
    const out: TransferLog[] = [];
    for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) out.push(...(await this.#source.transfersTo(addresses.slice(i, i + ADDRESS_CHUNK), from, to)));
    return out;
  }

  #pendingDeposits(): CreditRow[] {
    return this.#db.all<CreditRow>("SELECT * FROM payment_credits WHERE method = 'deposit' AND status = 'pending'");
  }

  /** Applies one scanned range: found logs become credits, pending credits in the range that were not found are dropped. */
  #apply(watched: Map<string, PaymentRow>, logs: TransferLog[], from: bigint, to: bigint, final: boolean) {
    this.#db.tx(() => {
      const seen = new Set<string>();
      for (const l of logs) {
        const p = watched.get(l.to.toLowerCase());
        if (!p || l.value === 0n) continue;
        seen.add(keyOf(l.txHash, l.logIndex));
        const existing = this.#db.get<CreditRow>("SELECT * FROM payment_credits WHERE tx_hash = ? AND log_index = ?", l.txHash, l.logIndex);
        if (existing) {
          if (existing.status === "confirmed") continue;
          if (final) this.#payments.confirmCredit(existing.id, { blockNumber: Number(l.blockNumber), blockHash: l.blockHash });
          else if (existing.block_hash !== l.blockHash) {
            // Re-included in another block of the unconfirmed tail.
            this.#db.run("UPDATE payment_credits SET block_number = ?, block_hash = ? WHERE id = ?", Number(l.blockNumber), l.blockHash, existing.id);
          }
          continue;
        }
        // A forwarder of an earlier quote (the checkout showed it before a re-quote) brings that quote back.
        if (l.to.toLowerCase() !== p.deposit_address.toLowerCase()) this.#payments.restoreForwarder(p.id, l.to);
        this.#payments.addCredit({
          paymentId: p.id,
          method: "deposit",
          payer: l.from,
          amount: l.value,
          txHash: l.txHash,
          logIndex: l.logIndex,
          blockNumber: Number(l.blockNumber),
          blockHash: l.blockHash,
          status: final ? "confirmed" : "pending",
          mayBeLate: true,
        });
      }
      for (const c of this.#pendingDeposits()) {
        const b = BigInt(c.block_number ?? 0);
        if (b < from || (to >= 0n && b > to) || seen.has(keyOf(c.tx_hash!, c.log_index!))) continue;
        this.#log.warn("deposit credit dropped: its block left the canonical chain", { paymentId: c.payment_id, txHash: c.tx_hash, blockNumber: c.block_number });
        this.#payments.dropCredit(c.id);
      }
      if (final) this.#setCursor(to);
    });
  }

  async #run(): Promise<void> {
    const { latest, final } = await this.#source.heads();
    let cursor = this.cursor();
    const watched = this.#payments.watched();
    if (watched.size === 0) {
      if (final > cursor) this.#setCursor(final);
      return;
    }
    while (cursor < final) {
      const to = cursor + MAX_LOG_RANGE < final ? cursor + MAX_LOG_RANGE : final;
      this.#apply(watched, await this.#scan(watched, cursor + 1n, to), cursor + 1n, to, true);
      cursor = to;
    }
    // The unconfirmed tail, rescanned every tick. Anything pending above `latest` (a shorter chain after a reorg) goes too.
    const tailFrom = cursor + 1n;
    const tail: TransferLog[] = [];
    try {
      for (let from = tailFrom; from <= latest; from += MAX_LOG_RANGE) {
        const to = from + MAX_LOG_RANGE - 1n < latest ? from + MAX_LOG_RANGE - 1n : latest;
        tail.push(...(await this.#scan(watched, from, to)));
      }
    } catch (err) {
      // A load-balanced RPC answered `latest` from one backend and the logs from one a block behind, which rejects the
      // range. Skip the tail this tick: nothing is applied, so no pending credit is dropped, and the next tick rescans.
      if (!(err instanceof BaseError && err.walk((e) => e instanceof InvalidParamsRpcError))) throw err;
      this.#log.debug("deposit watcher: RPC backend behind the head, rescanning the unconfirmed tail next tick", { latest: latest.toString() });
      return;
    }
    this.#apply(watched, tail, tailFrom, -1n, false);
  }
}

/**
 * Flush worker: after a deposit is confirmed, calls DepositFactory.flush for its forwarder (one call per forwarder,
 * whatever number of deposits it holds), with exponential backoff on failure. Housekeeping only: payment state never
 * depends on it, since the forwarder can pay nobody but the payout.
 */
export class Flusher {
  readonly #db: Database;
  readonly #chain: ChainClient;
  readonly #payments: PaymentService;
  readonly #log: Logger;
  readonly #clock: () => number;
  #busy: Promise<number> | null = null;

  constructor(o: { db: Database; chain: ChainClient; payments: PaymentService; log: Logger; clock?: () => number }) {
    this.#db = o.db;
    this.#chain = o.chain;
    this.#payments = o.payments;
    this.#log = o.log;
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  static backoffSec(attempts: number): number {
    return Math.min(30 * 2 ** attempts, 3_600);
  }

  tick(): Promise<number> {
    this.#busy ??= this.#run().finally(() => {
      this.#busy = null;
    });
    return this.#busy;
  }

  async #run(): Promise<number> {
    const due = this.#db.all<PaymentRow>(
      "SELECT * FROM payments WHERE flush_status = 'pending' AND flush_next_unix <= ? ORDER BY flush_next_unix LIMIT 10",
      this.#clock(),
    );
    for (const p of due) {
      try {
        let tx: Hex | null = p.flush_tx;
        // The current forwarder, then any of an earlier quote that money reached anyway, each with its own terms.
        const forwarders = [
          { address: p.deposit_address, terms: this.#payments.termsOf(p) },
          ...this.#payments
            .previousForwarders(p.id)
            .filter((f) => f.address.toLowerCase() !== p.deposit_address.toLowerCase())
            .map((f) => ({ address: f.address, terms: this.#payments.termsOf({ ...f, id: p.id, payout: p.payout }) })),
        ];
        for (const f of forwarders) {
          const balance = await this.#chain.public.readContract({ address: this.#chain.token, abi: erc20Abi, functionName: "balanceOf", args: [f.address] });
          if (balance === 0n) continue;
          const r = await this.#chain.send(this.#payments.rails.flushCall(f.terms, p.deposit_salt));
          if (r.status !== "success") throw new Error(`flush reverted in ${r.transactionHash}`);
          tx = r.transactionHash;
        }
        // A deposit confirmed while the flush was in flight set the payment back to pending; leave that one for the next round.
        this.#db.run(
          "UPDATE payments SET flush_status = 'done', flush_tx = ?, flush_error = NULL WHERE id = ? AND flush_status = 'pending' AND flush_next_unix = ?",
          tx,
          p.id,
          p.flush_next_unix,
        );
      } catch (err) {
        const attempts = p.flush_attempts + 1;
        const msg = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        this.#db.run(
          "UPDATE payments SET flush_attempts = ?, flush_next_unix = ?, flush_error = ? WHERE id = ?",
          attempts,
          this.#clock() + Flusher.backoffSec(attempts),
          msg.slice(0, 300),
          p.id,
        );
        this.#log.warn("forwarder flush failed; retrying with backoff", { paymentId: p.id, forwarder: p.deposit_address, attempts, err });
      }
    }
    return due.length;
  }
}
