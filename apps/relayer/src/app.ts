import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { BalanceWatch } from "./balance.ts";
import { SubmitError, type RelayChain } from "./chain.ts";
import { RELAY_OVERHEAD_TGAS, TGAS, type RelayerAppConfig } from "./config.ts";
import { badSignature, callFailed, expired, malformed, nonceUsed, rateLimited, RelayError, rpcFailed } from "./errors.ts";
import { DailyGasBudget, type GasLedgerStore } from "./gas-budget.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { checkAgainstChain, checkSponsored, parseSignedDelegate, type RelayPolicy, type SponsoredCall } from "./policy.ts";
import { clientIp, TokenBuckets } from "./ratelimit.ts";

export const RELAYER_VERSION = "0.1.0";

export type RelayerDeps = {
  /** All chain access. The service passes `NearRelayChain`; tests pass a fake. */
  chain: RelayChain;
  logger?: Logger;
  /** Wall clock in milliseconds, for rate limits and the daily budget. */
  now?: () => number;
  /** Keeps the daily gas count across restarts. Absent or null keeps it in memory. */
  gasLedger?: GasLedgerStore | null;
  /** The balance watch `/health` reports. Absent: the app creates its own. */
  balance?: BalanceWatch;
};

/** What `GET /info` returns. The dashboard reads it to know what this relayer pays for. */
export type RelayerInfo = {
  relayer: string;
  hub: string;
  network: "near:testnet" | "near:sandbox";
  methods: string[];
  maxGasTgas: number;
};

/** What `POST /relay` returns once the transaction is final. */
export type RelayResult = { txHash: string; sender: string; receiver: string; methods: string[] };

type Submitted = { at: number; txHash: string | null };

/**
 * Delegates this process has already handed to the network, by sender, key and nonce. A repeat is answered from here
 * instead of being sent again, which is what keeps an unknown outcome from ever becoming a second transaction.
 */
class SubmittedDelegates {
  readonly #entries = new Map<string, Submitted>();
  readonly #ttlMs: number;
  readonly #max: number;
  constructor(ttlMs = 3_600_000, max = 20_000) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }
  get(key: string, now: number): Submitted | undefined {
    const e = this.#entries.get(key);
    if (e && now - e.at > this.#ttlMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return e;
  }
  set(key: string, value: Submitted): void {
    if (!this.#entries.has(key) && this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, value);
  }
  delete(key: string): void {
    this.#entries.delete(key);
  }
}

const firstLine = (err: unknown): string => (err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)).slice(0, 240);

/**
 * The relayer as a Hono app: `GET /info`, `GET /health` and `POST /relay`. It can be served by itself (`startRelayer`)
 * or mounted inside another Hono app with `parent.route("/relayer", createRelayerApp(config, deps))`.
 *
 * It holds no key. Signing and sending live behind `deps.chain`.
 */
export function createRelayerApp(config: RelayerAppConfig, deps: RelayerDeps): Hono {
  const log = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => Date.now());
  const chain = deps.chain;
  const policy: RelayPolicy = {
    hub: config.hub,
    relayer: config.relayer,
    methods: config.methods,
    maxGas: BigInt(config.maxGasTgas) * TGAS,
    maxTtlBlocks: BigInt(config.maxTtlBlocks),
    expiryMarginBlocks: BigInt(config.expiryMarginBlocks),
  };
  const limiters = {
    ip: new TokenBuckets({ ...config.rateLimit.ip, now }),
    sender: new TokenBuckets({ ...config.rateLimit.sender, now }),
  };
  const budget = new DailyGasBudget({ limitGas: BigInt(config.dailyGasBudgetTgas) * TGAS, now, store: deps.gasLedger ?? null });
  const balance = deps.balance ?? new BalanceWatch({ chain, account: config.relayer, lowYocto: config.lowBalanceYocto, logger: log, now });
  const submitted = new SubmittedDelegates();
  let pending = 0;

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: config.corsOrigins.includes("*") ? "*" : [...config.corsOrigins],
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      exposeHeaders: ["Retry-After"],
      maxAge: 600,
    }),
  );

  // The per-address limit comes first, before a single body byte is read.
  app.use("/relay", async (c, next) => {
    if (c.req.method === "POST") {
      const ip = clientIp(c, config.trustProxyHops);
      const taken = limiters.ip.take(ip);
      if (!taken.ok) {
        log.info("relay refused", { ip, code: "RATE_LIMITED", status: 429, reason: "per-address limit" });
        throw rateLimited(`too many requests from this address. Wait ${taken.retryAfterSec} second(s) and send the same request again.`, taken.retryAfterSec);
      }
    }
    await next();
  });

  app.use(
    "*",
    bodyLimit({
      maxSize: config.maxBodyBytes,
      onError: (c) => {
        log.info("relay refused", { ip: clientIp(c, config.trustProxyHops), code: "PAYLOAD_TOO_LARGE", status: 413 });
        return c.json(
          {
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message: `the request body is larger than ${config.maxBodyBytes} bytes. A signed delegate for one hub call is a few hundred bytes. Send only {"signedDelegate":"<base64>"}.`,
            },
          },
          413,
        );
      },
    }),
  );

  app.onError((err, c) => {
    if (err instanceof RelayError) {
      if (err.details.retryAfterSec !== undefined) c.header("Retry-After", String(err.details.retryAfterSec));
      return c.json(err.toJSON(), err.status);
    }
    log.error("unhandled error", { path: c.req.path, err });
    return c.json({ error: { code: "INTERNAL", message: "the relayer hit an internal error and sent nothing. Try again in a moment; if it keeps happening, tell the relayer's operator." } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: `no route for ${c.req.method} ${c.req.path}. The relayer serves GET /info, GET /health and POST /relay.` } }, 404));

  app.get("/info", (c) => {
    const info: RelayerInfo = { relayer: config.relayer, hub: config.hub, network: config.network, methods: [...config.methods], maxGasTgas: config.maxGasTgas };
    return c.json(info);
  });

  app.get("/health", (c) => {
    balance.refreshIfStale();
    const gas = budget.snapshot();
    return c.json({
      ok: true,
      service: "payminto-relayer",
      version: RELAYER_VERSION,
      network: config.network,
      relayer: config.relayer,
      hub: config.hub,
      gas: { day: gas.day, usedTgas: Number(gas.usedGas / TGAS), budgetTgas: config.dailyGasBudgetTgas, resetsAt: gas.resetsAt },
      pending,
      balance: balance.status(),
    });
  });

  app.post("/relay", async (c) => {
    const started = now();
    const ip = clientIp(c, config.trustProxyHops);
    // What the delegate claims, for the log line. Until the checks pass these are claims, not facts.
    let claimed: { sender: string; receiver: string; methods: string[] } | undefined;
    try {
      const parsed = parseSignedDelegate(await readSignedDelegateField(c));
      const d = parsed.signed.delegateAction;
      claimed = { sender: d.senderId, receiver: d.receiverId, methods: d.actions.map((a) => (a.type === "FunctionCall" ? a.methodName.slice(0, 64) : a.type)).slice(0, 8) };
      const call = checkSponsored(parsed, policy);
      const result = await relay(call);
      log.info("relayed", { ip, sender: call.sender, receiver: call.receiver, methods: call.methods, txHash: result.txHash, gasTgas: Number(call.totalGas / TGAS), ms: now() - started });
      return c.json(result);
    } catch (err) {
      if (err instanceof RelayError) {
        log.info("relay refused", {
          ip,
          code: err.code,
          status: err.status,
          ...(claimed ?? {}),
          ...(err.details.txHash ? { txHash: err.details.txHash } : {}),
          ...(err.details.outcomeUnknown !== undefined ? { outcomeUnknown: err.details.outcomeUnknown } : {}),
          reason: err.message.slice(0, 200),
          ms: now() - started,
        });
      }
      throw err;
    }
  });

  async function readSignedDelegateField(c: Context): Promise<unknown> {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      throw malformed('the request body is not JSON. Send {"signedDelegate":"<base64 of the Borsh SignedDelegateAction>"} with Content-Type: application/json.');
    }
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("signedDelegate" in body)) {
      throw malformed('the request body has no signedDelegate field. Send {"signedDelegate":"<base64 of the Borsh SignedDelegateAction>"}.');
    }
    return (body as { signedDelegate: unknown }).signedDelegate;
  }

  /** The answer for a delegate this process already handed to the network: never a second send. */
  function refuseRepeat(id: string): void {
    const earlier = submitted.get(id, now());
    if (!earlier) return;
    throw nonceUsed(
      earlier.txHash
        ? `this delegate was already submitted as transaction ${earlier.txHash}, and the relayer does not send a delegate twice. Check that transaction (signer ${config.relayer}) before signing a new delegate.`
        : "this delegate is already being submitted, and the relayer does not send a delegate twice. Wait for the first request to answer.",
      earlier.txHash ? { txHash: earlier.txHash } : {},
    );
  }

  async function relay(call: SponsoredCall): Promise<RelayResult> {
    const d = call.signed.delegateAction;
    const id = `${d.senderId}|${d.publicKey}|${d.nonce}`;
    // Answered from memory, with the earlier transaction's hash, before any chain read.
    refuseRepeat(id);

    let height: bigint;
    let key: Awaited<ReturnType<RelayChain["accessKey"]>>;
    try {
      [height, key] = await Promise.all([chain.blockHeight(), chain.accessKey(d.senderId, d.publicKey)]);
    } catch (err) {
      log.warn("chain read failed before relaying", { sender: call.sender, err });
      throw rpcFailed("the relayer could not read NEAR to check this delegate, so nothing was sent. Try again in a moment with the same signedDelegate.", false);
    }
    checkAgainstChain(call, policy, { height, key });

    // From here to the send there is no await: the checks and the reservations below are one atomic step.
    // Checked again: another request with the same delegate may have passed the reads at the same time.
    refuseRepeat(id);
    // Only now, with a signature from a key that is on the sender's account, does a request count against that sender.
    const perSender = limiters.sender.take(d.senderId);
    if (!perSender.ok) throw rateLimited(`too many relays for ${d.senderId}. Wait ${perSender.retryAfterSec} second(s) and send the same request again.`, perSender.retryAfterSec);
    if (pending >= config.maxPending) throw rateLimited("the relayer is busy with other transactions. Wait a few seconds and send the same request again.", 3);
    const reservedGas = call.totalGas + BigInt(RELAY_OVERHEAD_TGAS) * TGAS;
    const reserved = budget.reserve(reservedGas);
    if (!reserved.ok) {
      const resetsAt = budget.snapshot().resetsAt;
      log.warn("daily gas budget is spent; refusing relays until it resets", { budgetTgas: config.dailyGasBudgetTgas, remainingTgas: Number(reserved.remainingGas / TGAS), resetsAt });
      throw rateLimited(
        `the relayer's daily gas budget of ${config.dailyGasBudgetTgas} Tgas cannot cover this call (${Number(reserved.remainingGas / TGAS)} Tgas left). It resets at ${resetsAt}. If this cannot wait, send the call with your own gas.`,
        reserved.retryAfterSec,
      );
    }
    submitted.set(id, { at: now(), txHash: null });
    pending++;

    try {
      const txHash = await chain.submitDelegate(call.bytes);
      submitted.set(id, { at: now(), txHash });
      return { txHash, sender: call.sender, receiver: call.receiver, methods: call.methods };
    } catch (err) {
      const failure = err instanceof SubmitError ? err.failure : "unknown";
      const txHash = err instanceof SubmitError ? err.txHash : undefined;
      const why = firstLine(err);
      if (failure === "not_sent" || failure === "rejected") {
        // Nothing ran, so nothing was spent and the same delegate may be tried again.
        budget.release(reservedGas);
        submitted.delete(id);
        if (failure === "rejected") log.error("the network refused the relayer's own transaction; check the relayer account's balance and key", { relayer: config.relayer, err });
        else log.warn("submission did not reach the network", { err });
        throw rpcFailed(
          failure === "rejected"
            ? `the network refused the relayer's own transaction before it ran (${why}), so nothing was relayed. Try again in a moment; if it keeps failing, the relayer's operator must check the relayer account.`
            : `the relayer could not reach NEAR (${why}), and nothing was sent. Try again in a moment with the same signedDelegate.`,
          false,
        );
      }
      submitted.set(id, { at: now(), txHash: txHash ?? null });
      const ref = txHash ? `transaction ${txHash} (signer ${config.relayer})` : "the transaction";
      switch (failure) {
        case "nonce_used":
          throw nonceUsed(`the network refused the delegate's nonce in ${ref}: it was used while this request was on its way. Read the key's nonce again, build a new delegate and sign it.`, txHash ? { txHash } : {});
        case "expired":
          throw expired(`the delegate expired before ${ref} ran. Build a new delegate with a later max_block_height, sign it and send it again.`, txHash ? { txHash } : {});
        case "key_error":
          throw badSignature(`the network refused the delegate's key in ${ref} (${why}). Sign a new delegate with a key that is on the account and may make this call.`);
        case "call_failed":
          throw callFailed(`the hub refused the call in ${ref}: ${why}. The call did not take effect. Fix the cause, then build a new delegate with a new nonce and sign it.`, txHash);
        default:
          log.error("submission outcome unknown; it will not be sent again", { sender: call.sender, txHash, err });
          throw rpcFailed(
            `${ref} was sent but its result is not known (${why}). It may still land, and the relayer will not send it again. Look up the transaction or read the hub's state before you sign anything new.`,
            true,
            txHash,
          );
      }
    } finally {
      pending--;
    }
  }

  return app;
}
