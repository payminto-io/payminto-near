import { z } from "zod";
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import { hspMandateToWire } from "@payminto/protocol";
import { errMessage, type HspPort, type HspSettleInput, type HspSettleOutcome } from "./port.ts";

const registerResponse = z.object({ paymentId: z.string().min(1), status: z.string().optional() }).loose();
const paymentResponse = z.object({ status: z.string() }).loose();
/** GET /chains entry (fields the node needs; the registry carries more). */
const chainEntry = z
  .object({
    name: z.string().min(1),
    chainId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform((v) => Number(v)),
    verifyingContract: z.string().refine((v) => isAddress(v, { strict: false }), "must be an address").transform((v) => getAddress(v)),
    adapterAddress: z.string().optional(),
  })
  .loose();
const chainsResponse = z.union([z.array(chainEntry), z.object({ chains: z.array(chainEntry) }).transform((o) => o.chains)]);

export class CoordinatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorConfigError";
  }
}

const TERMINAL_FAIL = new Set(["FAILED", "DISPUTED", "EXPIRED"]);

export type CoordinatorOptions = {
  url: string;
  apiKey: string;
  /** Fallback registry name when GET /chains has no entry for the chain id (or does not answer). */
  chainName?: string;
  /** Pin: GET /chains must report exactly this verifyingContract, or init() refuses. */
  verifyingContract?: Address;
  /** Capabilities committed to in every mandate and sent with each registration. */
  requiredCapabilities?: readonly string[];
  fetch?: typeof fetch;
  /** Backoff schedule for observe (202) and status polling, in ms. */
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * HSP_MODE=coordinator: registers the co-signed mandate with the HashKey HSP Coordinator, asks it to observe the
 * settlement tx (retrying while it answers 202), then polls until SETTLED. Failures are reported with retry=true;
 * the background worker retries them and they never block the clearing ledger.
 */
export class CoordinatorHspAdapter implements HspPort {
  readonly mode = "coordinator" as const;
  readonly requiredCapabilities: readonly string[];
  readonly #o: Required<Omit<CoordinatorOptions, "verifyingContract" | "chainName" | "requiredCapabilities">>;
  readonly #pinned: Address | undefined;
  readonly #fallbackName: string | undefined;
  #verifyingContract: Address | undefined;
  #chainName: string | undefined;

  constructor(o: CoordinatorOptions) {
    this.#pinned = o.verifyingContract;
    this.#verifyingContract = o.verifyingContract;
    this.#fallbackName = o.chainName;
    this.#chainName = o.chainName;
    this.requiredCapabilities = [...(o.requiredCapabilities ?? [])];
    this.#o = {
      url: o.url.replace(/\/+$/, ""),
      apiKey: o.apiKey,
      fetch: o.fetch ?? globalThis.fetch.bind(globalThis),
      backoffMs: o.backoffMs ?? [500, 1_000, 2_000, 4_000, 8_000, 15_000],
      sleep: o.sleep ?? defaultSleep,
    };
  }

  /** The HSP EIP-712 verifyingContract, resolved by init() from GET /chains (or the pin). */
  get verifyingContract(): Address {
    if (!this.#verifyingContract) throw new CoordinatorConfigError("coordinator adapter used before init()");
    return this.#verifyingContract;
  }

  /** The registry name payments are registered under. */
  get chainName(): string | undefined {
    return this.#chainName;
  }

  /**
   * Reads the Coordinator's chain registry (GET /chains) and resolves this chain by id: its registry name and the
   * HSP verifyingContract. A pinned HSP_VERIFYING_CONTRACT must match, otherwise the node refuses to start, because
   * mandates signed under a different domain would never verify. Without a registry entry the node falls back to
   * HSP_CHAIN_NAME and the pin, and refuses when either is missing.
   */
  async init(chainId: number): Promise<{ chainName: string; verifyingContract: Address; source: "registry" | "fallback" }> {
    let entry: z.infer<typeof chainEntry> | undefined;
    let registryError: string | null = null;
    try {
      const r = await this.#call("GET", "/chains");
      if (r.status >= 300) registryError = `GET /chains: HTTP ${r.status}`;
      else {
        const parsed = chainsResponse.safeParse(r.json);
        if (!parsed.success) registryError = "GET /chains: unexpected response shape";
        else entry = parsed.data.find((c) => c.chainId === chainId);
      }
    } catch (err) {
      registryError = `GET /chains: ${errMessage(err)}`;
    }
    if (entry) {
      if (this.#pinned && !isAddressEqual(this.#pinned, entry.verifyingContract)) {
        throw new CoordinatorConfigError(
          `HSP_VERIFYING_CONTRACT ${this.#pinned} differs from the Coordinator registry (${entry.verifyingContract} for chain ${chainId}); refusing to start`,
        );
      }
      // The registry is authoritative for the name; HSP_CHAIN_NAME is only a fallback.
      this.#chainName = entry.name;
      this.#verifyingContract = entry.verifyingContract;
      return { chainName: entry.name, verifyingContract: entry.verifyingContract, source: "registry" };
    }
    const why = registryError ?? `GET /chains has no entry for chain ${chainId}`;
    if (!this.#fallbackName || !this.#pinned) {
      throw new CoordinatorConfigError(`${why}; set HSP_CHAIN_NAME and HSP_VERIFYING_CONTRACT to start without the registry`);
    }
    this.#chainName = this.#fallbackName;
    this.#verifyingContract = this.#pinned;
    return { chainName: this.#fallbackName, verifyingContract: this.#pinned, source: "fallback" };
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#o.fetch(`${this.#o.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#o.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  async settle(input: HspSettleInput): Promise<HspSettleOutcome> {
    if (!input.signerProof) return { status: "UNSIGNED" };
    let coordinatorId = input.coordinatorId ?? null;
    try {
      if (!coordinatorId) {
        if (!this.#chainName) return { status: "FAILED", error: "coordinator adapter used before init()", retry: true };
        const r = await this.#call("POST", "/payments", {
          chain: this.#chainName,
          mandate: { body: hspMandateToWire(input.body), signerProof: input.signerProof, requiredCapabilities: [...this.requiredCapabilities] },
          attestations: [],
        });
        if (r.status >= 300) return { status: "FAILED", error: `register: HTTP ${r.status}`, retry: r.status >= 500 || r.status === 429 };
        coordinatorId = registerResponse.parse(r.json).paymentId;
      }
      const id = encodeURIComponent(coordinatorId);

      let observed = false;
      for (const wait of [0, ...this.#o.backoffMs]) {
        if (wait) await this.#o.sleep(wait);
        const r = await this.#call("POST", `/payments/${id}/observe`, { txHash: input.txHash });
        if (r.status === 202) continue;
        if (r.status >= 300) {
          return { status: "FAILED", coordinatorId, error: `observe: HTTP ${r.status}`, retry: r.status >= 500 || r.status === 429 };
        }
        observed = true;
        break;
      }
      if (!observed) return { status: "SUBMITTED", coordinatorId, coordinatorStatus: "OBSERVING", retry: true };

      let last = "UNKNOWN";
      for (const wait of [0, ...this.#o.backoffMs]) {
        if (wait) await this.#o.sleep(wait);
        const r = await this.#call("GET", `/payments/${id}`);
        if (r.status >= 300) continue;
        last = paymentResponse.parse(r.json).status.toUpperCase();
        if (last === "SETTLED") return { status: "SETTLED", coordinatorId, coordinatorStatus: last };
        if (TERMINAL_FAIL.has(last)) return { status: "FAILED", coordinatorId, coordinatorStatus: last, error: `coordinator status ${last}` };
      }
      return { status: "SUBMITTED", coordinatorId, coordinatorStatus: last, retry: true };
    } catch (err) {
      return { status: "FAILED", coordinatorId, error: errMessage(err), retry: true };
    }
  }
}
