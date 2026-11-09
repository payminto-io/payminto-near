import { paywall, type Paywall } from "@payminto/sdk";
import type { AgentsConfig } from "../config.ts";
import type { Database } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import type { Gateway } from "../gateway/index.ts";
import type { Logger } from "../logger.ts";
import { AgentService } from "./agents.ts";
import { ConnectionService } from "./connections.ts";
import { defaultModelLayer, withModelFetch, type ModelLayer } from "./models.ts";
import { IN_PROCESS_URL, merchantToolFactory, type OpsToolFactory } from "./ops-tools.ts";
import type { AgentRow } from "./rows.ts";
import { RunService } from "./runs.ts";
import { parseSecretsKey, SecretBox } from "./secrets.ts";
import { AgentWorker } from "./worker.ts";

export const DEFAULT_SKILL_WAIT_MS = 25_000;

export type AgentsDeps = {
  config: AgentsConfig;
  db: Database;
  events: EventBus;
  gateway: Gateway;
  log: Logger;
  publicUrl: string;
  /** Replaces parts of the model layer (tests use a scripted model). */
  models?: Partial<ModelLayer>;
  /** HTTP client for model providers (tests point it at mock servers). */
  modelFetch?: typeof fetch;
  /** Replaces the ops tools (tests). */
  tools?: OpsToolFactory;
};

/**
 * Merchant AI agents (docs/AGENTS.md): connections, agents, runs and the worker, wired to the gateway (merchants,
 * API keys, webhooks) and the node's event stream.
 */
export class AgentsModule {
  readonly config: AgentsConfig;
  readonly box: SecretBox;
  readonly connections: ConnectionService;
  readonly agents: AgentService;
  readonly runs: RunService;
  readonly worker: AgentWorker | null;
  readonly gateway: Gateway;
  readonly skillWaitMs: number;
  readonly #log: Logger;
  readonly #publicUrl: string;
  #fetch: typeof fetch | null = null;
  readonly #paywalls = new Map<string, Paywall>();

  constructor(d: AgentsDeps) {
    this.config = d.config;
    this.gateway = d.gateway;
    this.#log = d.log;
    this.#publicUrl = d.publicUrl.replace(/\/+$/, "");
    this.skillWaitMs = d.config.skillWaitMs ?? DEFAULT_SKILL_WAIT_MS;
    const keys = new Map(Object.entries(d.config.secretsKeys).map(([v, k]) => [Number(v), parseSecretsKey(k)] as const));
    this.box = new SecretBox(keys, d.config.secretsKeyVersion);
    const models: ModelLayer = { ...defaultModelLayer, ...d.models };
    // The model fetch is bound into every call, so tests can point all providers at a mock server.
    const layer = d.modelFetch ? withModelFetch(models, d.modelFetch) : models;
    this.connections = new ConnectionService({ db: d.db, box: this.box, models: layer, allowPrivateModelUrls: d.config.allowPrivateModelUrls });
    this.agents = new AgentService({ db: d.db, box: this.box, connections: this.connections, publicUrl: d.publicUrl });
    this.runs = new RunService({ db: d.db, events: d.events, webhooks: d.gateway.webhooks });
    const tools = d.tools ?? merchantToolFactory({ keys: d.gateway.keys, fetch: () => this.selfFetch() });
    this.worker =
      d.config.workers > 0
        ? new AgentWorker({
            runs: this.runs,
            agents: this.agents,
            connections: this.connections,
            tools,
            log: d.log,
            workers: d.config.workers,
            maxPerMerchant: d.config.maxPerMerchant,
            pollMs: d.config.pollMs,
            idlePollMs: d.config.idlePollMs,
            leaseMs: d.config.leaseMs,
            heartbeatMs: d.config.heartbeatMs,
            retryDelaysMs: d.config.retryDelaysMs,
          })
        : null;
  }

  /** The node's own app as a fetch function: ops tools and skill paywalls call the API in-process. */
  bindFetch(f: typeof fetch): void {
    this.#fetch = f;
  }

  selfFetch(): typeof fetch {
    if (!this.#fetch) throw new Error("agents: the API is not mounted yet");
    return this.#fetch;
  }

  start(): void {
    this.worker?.start();
  }

  async stop(): Promise<void> {
    await this.worker?.stop();
  }

  /**
   * The paywall of a skill: its provider at this node, through the in-process API. Rebuilt when the price or the
   * payout changes, because the paywall caches its requirements.
   */
  paywallFor(agent: AgentRow, payee: string): Paywall {
    const key = `${agent.provider_id}|${agent.price}|${payee}`;
    let p = this.#paywalls.get(key);
    if (!p) {
      for (const k of this.#paywalls.keys()) if (k.startsWith(`${agent.provider_id}|`)) this.#paywalls.delete(k);
      p = paywall({
        nodeUrl: IN_PROCESS_URL,
        providerId: agent.provider_id!,
        apiKey: this.agents.providerKey(agent),
        price: agent.price!,
        description: agent.description || agent.name,
        mimeType: "application/json",
        maxTimeoutSeconds: 120,
        publicNodeUrl: this.#publicUrl,
        fetch: this.selfFetch(),
      });
      this.#paywalls.set(key, p);
    }
    return p;
  }

  get log(): Logger {
    return this.#log;
  }
}
