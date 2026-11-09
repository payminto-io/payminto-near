import {
  BaseError,
  createPublicClient,
  createTransport,
  createWalletClient,
  defineChain,
  erc20Abi,
  fallback,
  getAddress,
  hashDomain,
  http,
  toFunctionSelector,
  HttpRequestError,
  keccak256,
  LimitExceededRpcError,
  TimeoutError,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
  type TransactionReceipt,
  type EIP1193RequestFn,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { estimateL1Fee } from "viem/op-stack";
import { clearingHubAbi, fiatTokenBlacklistAbi, hashkeyContracts, networkFor } from "@payminto/protocol";
import { DEFAULT_TX_POLICY, type ConfirmTag, type TxPolicy } from "./config.ts";

/** The parts of a token's EIP-712 domain beyond ERC-20: FiatToken and OpenZeppelin ERC20Permit both expose these. */
const tokenDomainAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

const OPEN_WITH_PERMIT_SELECTOR = toFunctionSelector(
  clearingHubAbi.find((f) => f.type === "function" && f.name === "openMandateWithPermit") as Parameters<typeof toFunctionSelector>[0],
).toLowerCase();

/** One operator transaction broadcast: the original or a same-nonce replacement. */
export type SentTx = { hash: Hex; raw: Hex; nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; replacement: number };

export type SendOptions = {
  /** Called synchronously after every broadcast (original and replacements), before waiting, so callers can persist it. */
  onSent?: (tx: SentTx) => void;
};

/** The operator wallet cannot pay the estimated L2 execution plus L1 data fee of a transaction. */
export class OperatorFundsError extends Error {
  readonly required: bigint;
  readonly balance: bigint;
  constructor(required: bigint, balance: bigint, l1Fee: bigint) {
    super(`operator balance ${balance} wei is below the estimated fee ${required} wei (L1 data fee ${l1Fee} wei); fund the operator`);
    this.name = "OperatorFundsError";
    this.required = required;
    this.balance = balance;
  }
}

/** None of the broadcast transactions was included before the timeout; they may still be mined later. */
export class TxNotIncludedError extends Error {
  readonly hashes: Hex[];
  constructor(hashes: Hex[], reason: string) {
    super(`transaction not included: ${reason} (${hashes.join(", ")})`);
    this.name = "TxNotIncludedError";
    this.hashes = hashes;
  }
}

/** Raise every fee by 12.5 % (rounded up, at least 1 wei): above the 10 % replacement minimum that geth-based nodes enforce. */
export function bumpFees(f: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const up = (x: bigint) => {
    const b = (x * 1125n + 999n) / 1000n;
    return b > x ? b : x + 1n;
  };
  return { maxFeePerGas: up(f.maxFeePerGas), maxPriorityFeePerGas: up(f.maxPriorityFeePerGas) };
}

/**
 * Transient JSON-RPC failures worth retrying: network errors and timeouts, HTTP 408, 429 and 5xx, and rate-limit
 * JSON-RPC errors. Reverts, invalid params (for example the 5,001-block eth_getLogs limit) and nonce errors are not.
 */
export function isTransientRpcError(err: unknown): boolean {
  const chain: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && i < 8; i++) {
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  for (const e of chain) {
    if (e instanceof TimeoutError) return true;
    if (e instanceof LimitExceededRpcError) return true;
    if (e instanceof HttpRequestError) {
      const st = e.status;
      return st === undefined || st === 408 || st === 429 || st >= 500;
    }
    const code = (e as { code?: unknown }).code;
    const raw = (e as { message?: unknown }).message;
    const msg = typeof raw === "string" ? raw : "";
    if (code === 429 || code === -32005) return true;
    // -32603 is the provider's internal error ("We are not able to process your request at this time" from a public
    // endpoint); some nodes also report a revert under it, which is never transient.
    if (code === -32603 && !/revert/i.test(msg)) return true;
    if (/rate limit|too many requests|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i.test(msg)) return true;
  }
  return false;
}

export type RetryOptions = {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Backoff for attempt n (0-based): exponential, capped, with "equal jitter" (half fixed, half random). */
export function backoffDelay(attempt: number, o: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "random"> = {}): number {
  const base = o.baseDelayMs ?? 250;
  const cap = o.maxDelayMs ?? 8_000;
  const d = Math.min(cap, base * 2 ** attempt);
  return d / 2 + (o.random ?? Math.random)() * (d / 2);
}

/** Wraps a transport so transient failures are retried with exponential backoff and jitter; other errors pass through. */
export function retryingTransport(inner: Transport, o: RetryOptions): Transport {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return (params) => {
    const t = inner({ ...params, retryCount: 0 });
    return createTransport({
      key: "retrying",
      name: "Retrying JSON-RPC",
      type: "retrying",
      retryCount: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request: (async (args: any) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await t.request(args);
          } catch (err) {
            if (attempt >= o.retries || !isTransientRpcError(err)) throw err;
            await sleep(backoffDelay(attempt, o));
          }
        }
      }) as EIP1193RequestFn,
    });
  };
}

/** Error text including the node's own reason (viem keeps "nonce too low" and friends in `details`). */
const errText = (e: unknown) => (e instanceof BaseError ? `${e.shortMessage} ${e.details ?? ""}` : e instanceof Error ? e.message : String(e));

export type OnchainMandate = {
  owner: Address;
  agent: Address;
  token: Address;
  validAfter: bigint;
  validUntil: bigint;
  revokedAt: bigint;
  totalCap: bigint;
  spent: bigint;
  payeesRoot: Hex;
};

/** Serializes async work: operator transactions must not race on nonces. */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export class ChainClient {
  readonly chainId: number;
  readonly chain: Chain;
  readonly hub: Address;
  readonly token: Address;
  readonly operator: PrivateKeyAccount;
  readonly public: PublicClient<Transport, Chain>;
  readonly wallet: WalletClient<Transport, Chain, Account>;
  readonly txQueue = new SerialQueue();

  readonly confirmTag: ConfirmTag;
  readonly txPolicy: TxPolicy;
  readonly #sleep: (ms: number) => Promise<void>;
  #gpoPresent: Promise<boolean> | null = null;
  #multicall: Promise<Address | null> | null = null;
  readonly #blacklistSupport = new Map<string, boolean>();
  readonly #permitOpened = new Map<string, boolean>();

  constructor(opts: {
    chainId: number;
    rpcUrl: string;
    rpcFallbackUrls?: readonly string[];
    hub: Address;
    token: Address;
    operatorKey: Hex;
    confirmTag?: ConfirmTag;
    tx?: TxPolicy;
    rpcRetries?: number;
    /** Test seam for retry delays. */
    sleep?: (ms: number) => Promise<void>;
  }) {
    const net = networkFor(opts.chainId);
    this.chainId = opts.chainId;
    this.chain = defineChain({ ...net.chain, rpcUrls: { default: { http: [opts.rpcUrl] } } });
    this.hub = getAddress(opts.hub);
    this.token = getAddress(opts.token);
    // No viem nonce manager: every operator transaction goes through send(), which reads the pending nonce inside the
    // serial queue and keeps it across fee-bump replacements.
    this.operator = privateKeyToAccount(opts.operatorKey);
    this.confirmTag = opts.confirmTag ?? "latest";
    this.txPolicy = opts.tx ?? DEFAULT_TX_POLICY;
    this.#sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const urls = [opts.rpcUrl, ...(opts.rpcFallbackUrls ?? []).filter((u) => u !== opts.rpcUrl)];
    const transports = urls.map((u) => http(u, { retryCount: 0, timeout: 20_000 }));
    // Fallback keeps RPC_URL first and moves to the next endpoint only when a request fails; the retrying wrapper
    // then retries the whole chain with jittered exponential backoff on transient errors and 429.
    const inner: Transport = transports.length > 1 ? fallback(transports, { retryCount: 0 }) : transports[0]!;
    const transport = retryingTransport(inner, { retries: opts.rpcRetries ?? 4, sleep: opts.sleep });
    this.public = createPublicClient({ chain: this.chain, transport, pollingInterval: 250 });
    this.wallet = createWalletClient({ chain: this.chain, transport, account: this.operator });
  }

  /**
   * Symbol, decimals and the token's own EIP-712 domain, verified against the token's DOMAIN_SEPARATOR() so a
   * deployment's own test token signs correctly. Candidates, in order: the token's ERC-5267 eip712Domain(), the known
   * domain from chains.ts when this is the network's token, and (name(), version() or "1"). Fails closed: an RPC error
   * (after the transport's retries) is rethrown rather than read as "function absent", a token whose separator matches
   * no candidate is refused, and an unknown token without a readable separator is refused, because signing against a
   * wrong domain would make every authorization fail on chain.
   */
  async tokenMeta(): Promise<{ symbol: string; decimals: number; eip712: { name: string; version: string } }> {
    const net = networkFor(this.chainId);
    // null only when the token does not implement the function (revert or no data); transient RPC errors propagate.
    const optional = async <T>(p: Promise<T>): Promise<T | null> => {
      try {
        return await p;
      } catch (err) {
        if (isTransientRpcError(err)) throw err;
        return null;
      }
    };
    const t = { address: this.token, abi: tokenDomainAbi } as const;
    const [symbol, decimals, name, version, separator, domain5267] = await Promise.all([
      optional(this.public.readContract({ address: this.token, abi: erc20Abi, functionName: "symbol" })),
      optional(this.public.readContract({ address: this.token, abi: erc20Abi, functionName: "decimals" })),
      optional(this.public.readContract({ ...t, functionName: "name" })),
      optional(this.public.readContract({ ...t, functionName: "version" })),
      optional(this.public.readContract({ ...t, functionName: "DOMAIN_SEPARATOR" })),
      optional(this.public.readContract({ ...t, functionName: "eip712Domain" })),
    ]);
    const known = getAddress(this.token) === getAddress(net.token.address) ? net.token : null;
    const candidates = [
      domain5267 ? { name: domain5267[1], version: domain5267[2] } : null,
      known?.eip712 ?? null,
      name !== null ? { name, version: version ?? "1" } : null,
    ].filter((d): d is { name: string; version: string } => d !== null);
    const matches = (d: { name: string; version: string }) =>
      hashDomain({
        domain: { ...d, chainId: BigInt(this.chainId), verifyingContract: this.token },
        types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
      }) === separator;
    const where = `Token ${this.token} on chain ${this.chainId}`;
    let eip712: { name: string; version: string } | undefined;
    if (separator !== null) {
      eip712 = candidates.find(matches);
      if (!eip712) throw new Error(`${where}: its DOMAIN_SEPARATOR matches none of ${candidates.map((d) => `("${d.name}", "${d.version}")`).join(", ") || "the candidate domains"}`);
    } else if (known) {
      eip712 = known.eip712;
    } else {
      throw new Error(`${where}: has no DOMAIN_SEPARATOR(), so its EIP-712 domain cannot be verified; it cannot take signed payments`);
    }
    if ((symbol === null || decimals === null) && !known) throw new Error(`${where}: does not answer symbol() and decimals() like an ERC-20`);
    return { symbol: symbol ?? known!.symbol, decimals: decimals ?? known!.decimals, eip712 };
  }

  async funds(address: Address, token = this.token): Promise<{ balance: bigint; allowance: bigint }> {
    const [balance, allowance] = await Promise.all([
      this.public.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      this.public.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, this.hub] }),
    ]);
    return { balance, allowance };
  }

  /**
   * How a mandate was onboarded, read from chain: whether its open transaction called openMandateWithPermit (the agent
   * signed an EIP-2612 permit and paid no gas) and how many transactions the agent wallet has ever sent (its nonce).
   */
  async onboarding(openTxHash: Hex, agent: Address): Promise<{ gaslessPermit: boolean; agentTransactions: number; agentNativeBalance: string }> {
    let gasless = this.#permitOpened.get(openTxHash);
    if (gasless === undefined) {
      const tx = await this.public.getTransaction({ hash: openTxHash });
      gasless = tx.input.slice(0, 10).toLowerCase() === OPEN_WITH_PERMIT_SELECTOR;
      this.#permitOpened.set(openTxHash, gasless);
    }
    const [agentTransactions, native] = await Promise.all([this.public.getTransactionCount({ address: agent }), this.public.getBalance({ address: agent })]);
    return { gaslessPermit: gasless, agentTransactions, agentNativeBalance: native.toString() };
  }

  async mandate(id: Hex): Promise<OnchainMandate | null> {
    const r = await this.public.readContract({ address: this.hub, abi: clearingHubAbi, functionName: "mandates", args: [id] });
    const [owner, agent, token, validAfter, validUntil, revokedAt, totalCap, spent, payeesRoot] = r as readonly [
      Address,
      Address,
      Address,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      Hex,
    ];
    if (owner === "0x0000000000000000000000000000000000000000") return null;
    return { owner, agent, token, validAfter, validUntil, revokedAt, totalCap, spent, payeesRoot };
  }

  async settledOf(id: Hex, payee: Address): Promise<bigint> {
    return (await this.public.readContract({
      address: this.hub,
      abi: clearingHubAbi,
      functionName: "settled",
      args: [id, payee],
    })) as bigint;
  }

  async settleDeadline(id: Hex): Promise<bigint> {
    return BigInt(
      (await this.public.readContract({ address: this.hub, abi: clearingHubAbi, functionName: "settleDeadline", args: [id] })) as
        | bigint
        | number,
    );
  }

  /** The hub's record of a batch; `blockNumber` pins the read so a lagging load-balanced backend cannot answer it. */
  async onchainBatch(batchId: Hex, blockNumber?: bigint): Promise<{ receiptsRoot: Hex; token: Address; settledAt: bigint; gross: bigint; net: bigint }> {
    const r = (await this.public.readContract({
      address: this.hub,
      abi: clearingHubAbi,
      functionName: "batches",
      args: [batchId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    })) as readonly [Hex, Address, Address, bigint | number, bigint, bigint];
    return { receiptsRoot: r[0], token: r[1], settledAt: BigInt(r[3]), gross: r[4], net: r[5] };
  }

  async isContract(address: Address): Promise<boolean> {
    const code = await this.public.getCode({ address });
    return !!code && code !== "0x";
  }

  async waitForReceipt(hash: Hex, timeoutMs = 120_000): Promise<TransactionReceipt> {
    return this.public.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 250 });
  }

  /** The receipt, or null when the node does not know the transaction (not yet mined, or reorged out). */
  async receiptOf(hash: Hex): Promise<TransactionReceipt | null> {
    try {
      return await this.public.getTransactionReceipt({ hash });
    } catch (err) {
      if (err instanceof BaseError && err.walk((e) => (e as { name?: string }).name === "TransactionReceiptNotFoundError")) return null;
      throw err;
    }
  }

  /** Block number of the given head: latest (1 confirmation), safe (batch posted to Ethereum) or finalized. */
  async headOf(tag: ConfirmTag = this.confirmTag): Promise<bigint> {
    // Uncached: viem otherwise serves the head from a short cache, which can trail a receipt just returned.
    if (tag === "latest") return this.public.getBlockNumber({ cacheTime: 0 });
    return (await this.public.getBlock({ blockTag: tag })).number!;
  }

  /** L1 data fee a receipt reports (OP Stack formatters); null when the chain or node does not report one. */
  static l1FeeOf(receipt: TransactionReceipt): bigint | null {
    const v = (receipt as TransactionReceipt & { l1Fee?: bigint | null }).l1Fee;
    return typeof v === "bigint" ? v : null;
  }

  /** Whether the OP Stack GasPriceOracle predeploy exists here (HashKey Chain and its forks; not plain anvil). */
  hasGasPriceOracle(): Promise<boolean> {
    this.#gpoPresent ??= this.isContract(hashkeyContracts[177].gasPriceOracle).catch((err) => {
      this.#gpoPresent = null;
      throw err;
    });
    return this.#gpoPresent;
  }

  /** Multicall3 address when deployed on this chain (HashKey Chain and forks), else null (plain anvil). */
  #multicall3(): Promise<Address | null> {
    const addr = hashkeyContracts[177].multicall3;
    this.#multicall ??= this.isContract(addr)
      .then((ok) => (ok ? addr : null))
      .catch((err) => {
        this.#multicall = null;
        throw err;
      });
    return this.#multicall;
  }

  /**
   * Whether the token has a FiatToken-style blacklist. A token without `isBlacklisted` (the call reverts or returns no
   * data) has none; RPC failures are rethrown, never read as "no blacklist".
   */
  async supportsBlacklist(token = this.token): Promise<boolean> {
    const key = token.toLowerCase();
    const known = this.#blacklistSupport.get(key);
    if (known !== undefined) return known;
    let ok: boolean;
    try {
      await this.public.readContract({ address: token, abi: fiatTokenBlacklistAbi, functionName: "isBlacklisted", args: [zeroAddress] });
      ok = true;
    } catch (err) {
      if (isTransientRpcError(err)) throw err;
      ok = false;
    }
    this.#blacklistSupport.set(key, ok);
    return ok;
  }

  /** The subset of `parties` the token blacklists, read in one Multicall3 call where available. */
  async blacklisted(parties: readonly Address[], token = this.token): Promise<Set<string>> {
    const unique = [...new Set(parties.map((p) => getAddress(p)))];
    if (unique.length === 0 || !(await this.supportsBlacklist(token))) return new Set();
    const contracts = unique.map((p) => ({ address: token, abi: fiatTokenBlacklistAbi, functionName: "isBlacklisted" as const, args: [p] as const }));
    const mc = await this.#multicall3();
    const flags = mc
      ? await this.public.multicall({ contracts, allowFailure: false, multicallAddress: mc })
      : await Promise.all(contracts.map((c) => this.public.readContract(c)));
    return new Set(unique.filter((_, i) => flags[i]).map((p) => p.toLowerCase()));
  }

  /**
   * Sends an operator transaction and waits for one confirmation. Runs inside the serial queue: reads the pending nonce,
   * checks the operator can pay L2 execution plus the L1 data fee, broadcasts, and if no broadcast is included after
   * `bumpAfterBlocks` blocks, sends a same-nonce replacement with fees raised 12.5 %, up to `maxBumps` times.
   * Any of the broadcasts may be the one that is mined; the receipt of whichever it was is returned.
   */
  send(req: { to: Address; data: Hex }, o: SendOptions = {}): Promise<TransactionReceipt> {
    return this.txQueue.run(async () => {
      const account = this.operator;
      const nonce = await this.public.getTransactionCount({ address: account.address, blockTag: "pending" });
      const prepared = await this.public.prepareTransactionRequest({
        account,
        chain: this.chain,
        to: req.to,
        data: req.data,
        nonce,
        type: "eip1559",
      });
      const gas = prepared.gas!;
      let fees = { maxFeePerGas: prepared.maxFeePerGas!, maxPriorityFeePerGas: prepared.maxPriorityFeePerGas! };
      await this.#preflight({ to: req.to, data: req.data, nonce, gas, ...fees });

      const sent: SentTx[] = [];
      const broadcast = async () => {
        const raw = await account.signTransaction({
          chainId: this.chainId,
          type: "eip1559",
          to: req.to,
          data: req.data,
          nonce,
          gas,
          ...fees,
        });
        const hash = keccak256(raw);
        try {
          await this.public.sendRawTransaction({ serializedTransaction: raw });
        } catch (err) {
          const m = errText(err);
          if (/already known|known transaction|already imported/i.test(m)) {
            // A retried broadcast the node already holds: it is in flight.
          } else if (sent.length > 0 && /nonce too low|underpriced/i.test(m)) {
            // A sibling was already mined, or the replacement was refused: keep waiting (the next bump goes higher).
            return;
          } else throw err;
        }
        const tx: SentTx = { hash, raw, nonce, ...fees, replacement: sent.length };
        sent.push(tx);
        o.onSent?.(tx);
      };
      await broadcast();

      let sentAt = await this.public.getBlockNumber();
      let bumps = 0;
      let nonceGone = 0;
      const deadline = Date.now() + this.txPolicy.inclusionTimeoutSec * 1000;
      for (;;) {
        for (const tx of [...sent].reverse()) {
          const r = await this.receiptOf(tx.hash);
          if (r) return r;
        }
        const [head, mined] = await Promise.all([
          this.public.getBlockNumber(),
          this.public.getTransactionCount({ address: account.address, blockTag: "latest" }),
        ]);
        if (mined > nonce) {
          // The nonce is used but none of our hashes has a receipt yet: give the node a couple of polls to index it.
          if (++nonceGone > 8) throw new TxNotIncludedError(sent.map((t) => t.hash), `nonce ${nonce} was used by another transaction`);
        } else if (head - sentAt >= BigInt(this.txPolicy.bumpAfterBlocks) && bumps < this.txPolicy.maxBumps) {
          bumps++;
          fees = bumpFees(fees);
          await broadcast();
          sentAt = head;
        }
        if (Date.now() > deadline) throw new TxNotIncludedError(sent.map((t) => t.hash), `no receipt after ${this.txPolicy.inclusionTimeoutSec}s`);
        await this.#sleep(this.public.pollingInterval);
      }
    });
  }

  /** Re-sends a signed transaction (after a reorg dropped it). "ok" also covers a node that already has it. */
  async rebroadcast(raw: Hex): Promise<"ok" | "nonce-used"> {
    try {
      await this.public.sendRawTransaction({ serializedTransaction: raw });
      return "ok";
    } catch (err) {
      const m = errText(err);
      if (/already known|known transaction|already imported/i.test(m)) return "ok";
      if (/nonce too low|replacement transaction underpriced/i.test(m)) return "nonce-used";
      throw err;
    }
  }

  /** Refuses to broadcast what the operator cannot pay: gas x maxFeePerGas plus the OP Stack L1 data fee. */
  async #preflight(tx: { to: Address; data: Hex; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
    const l1Fee = (await this.hasGasPriceOracle())
      ? await estimateL1Fee(this.public, {
          account: this.operator,
          chain: this.chain,
          to: tx.to,
          data: tx.data,
          nonce: tx.nonce,
          gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        })
      : 0n;
    const required = tx.gas * tx.maxFeePerGas + l1Fee;
    const balance = await this.public.getBalance({ address: this.operator.address });
    if (balance < required) throw new OperatorFundsError(required, balance, l1Fee);
    return { l1Fee, required };
  }

  /** Operator preflight without sending (tests and the gas script): estimated L2 plus L1 fee. */
  async estimateFee(req: { to: Address; data: Hex }): Promise<{ l1Fee: bigint; required: bigint }> {
    const nonce = await this.public.getTransactionCount({ address: this.operator.address, blockTag: "pending" });
    const p = await this.public.prepareTransactionRequest({ account: this.operator, chain: this.chain, to: req.to, data: req.data, nonce, type: "eip1559" });
    return this.#preflight({ to: req.to, data: req.data, nonce, gas: p.gas!, maxFeePerGas: p.maxFeePerGas!, maxPriorityFeePerGas: p.maxPriorityFeePerGas! });
  }
}
