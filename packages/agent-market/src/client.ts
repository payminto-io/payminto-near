import { z } from "zod";
import { CATEGORIES, DEFAULT_TIMEOUT_MS, LISTING_STATUSES, MARKET_ORIGIN, MAX_DELIVERABLE_BYTES, MAX_LIST_RESPONSE_BYTES, MAX_SMALL_RESPONSE_BYTES, type Category, type ListingStatus } from "./constants.ts";
import { MarketError, Secret } from "./errors.ts";
import { Http, argument, errorFromResponse, httpsUrl, parseJson, parseWith, type HttpOptions } from "./http.ts";
import {
  adoptionCodeSchema,
  agentCardSchema,
  agentSchema,
  assignmentRowSchema,
  assignmentSchema,
  assignmentsEnvelopeSchema,
  browseAgentsSchema,
  handleSchema,
  isHandle,
  listingSchema,
  priceSchema,
  pricingPlanSchema,
  pricingPlansSchema,
  registrationSchema,
  startedSchema,
  x402RecipientsSchema,
  type AdoptionCode,
  type Agent,
  type AgentCard,
  type Assignment,
  type AssignmentRow,
  type Listing,
  type PricingPlan,
  type Registration,
  type X402Recipients,
} from "./schemas.ts";

export type MarketClientOptions = HttpOptions & {
  /** The market's origin. Only https is accepted. Default: https://market.near.ai. */
  origin?: string;
  /** The agent's `aat_` token. Needed for the worker loop and the listing calls, never for search or quotes. */
  token?: string | Secret;
  timeoutMs?: number;
  /** Share one Http (and so one rate limiter) between several clients. */
  http?: Http;
};

export type SearchQuery = { q?: string; category?: Category; sort?: "delivered" | "recent"; limit?: number; offset?: number };

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const registerInput = z.strictObject({
  handle: handleSchema,
  name: z.string().trim().min(1).max(80),
  category: z.enum(CATEGORIES),
  email: z.string().max(254).regex(/^[^\s@]+@[^\s@]+$/).optional(),
  slaSeconds: z.number().int().min(1).max(2_592_000).optional(),
});
export type RegisterInput = z.infer<typeof registerInput>;

const planInput = z.strictObject({
  /** Whole currency units per call, for example "0.25". */
  priceAmount: priceSchema,
  slaSeconds: z.number().int().min(1).max(2_592_000).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(500).optional(),
});
export type PricingPlanInput = z.infer<typeof planInput>;

type Call<S extends z.ZodType> = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  what: string;
  schema: S;
  auth?: boolean;
  json?: unknown;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Replaces the general advice of a NOT_FOUND. */
  notFound?: string;
};

/**
 * A typed client for the parts of the NEAR AI Agent Market API that Payminto uses.
 *
 * Reads (search, cards, plans) need no account. The worker loop and the listing calls need the agent's `aat_` token,
 * which is sent only to the market's own origin and never appears in an error, a log line or `JSON.stringify`.
 * Nothing here moves money: the market holds and pays out its own jobs.
 */
export class MarketClient {
  readonly origin: string;
  /** The host every agent's own host hangs under, for example `market.near.ai`. */
  readonly host: string;
  readonly http: Http;
  readonly timeoutMs: number;
  readonly #token: Secret | null;

  constructor(o: MarketClientOptions = {}) {
    const url = httpsUrl(o.origin ?? MARKET_ORIGIN);
    if (url.pathname !== "/" || url.search || url.hash) throw new MarketError("INVALID_ARGUMENT", "the market origin must not have a path");
    this.origin = url.origin;
    this.host = url.host;
    this.http = o.http ?? new Http(o);
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#token = o.token === undefined || o.token === "" ? null : o.token instanceof Secret ? o.token : new Secret(o.token);
    if (this.#token && !/^aat_[A-Za-z0-9]{16,128}$/.test(this.#token.reveal())) {
      throw new MarketError("INVALID_ARGUMENT", "the agent token must look like aat_ followed by letters and digits", {
        nextStep: "Copy the token again from the agent's Edit page under Agent API tokens. It is shown once, so create a new one if it is lost.",
      });
    }
  }

  get hasToken(): boolean {
    return this.#token !== null;
  }

  /** The agent's own host: its card, its 402 and its A2A endpoint live there, never on the apex. */
  agentOrigin(handle: string): string {
    if (!isHandle(handle)) {
      throw new MarketError("INVALID_ARGUMENT", "a handle is 3 to 30 characters: a lowercase letter, then lowercase letters, digits and hyphens", {
        nextStep: "Use the agent's handle as `market search <query>` prints it, not its display name.",
      });
    }
    return `https://${handle}.${this.host}`;
  }

  a2aEndpoint(handle: string): string {
    return `${this.agentOrigin(handle)}/a2a/v1`;
  }

  async #call<S extends z.ZodType>(c: Call<S>): Promise<z.output<S>> {
    const headers: Record<string, string> = {};
    if (c.auth) {
      if (!this.#token) throw new MarketError("TOKEN_REQUIRED", `${c.what} needs an agent token`);
      // The token goes to the market's own origin and nowhere else.
      if (new URL(c.url).origin !== this.origin) throw new MarketError("INVALID_ARGUMENT", "refusing to send the agent token outside the market origin");
      headers.authorization = `Bearer ${this.#token.reveal()}`;
    }
    const res = await this.http.send({
      url: c.url,
      method: c.method,
      headers,
      ...(c.json !== undefined ? { json: c.json } : {}),
      timeoutMs: this.timeoutMs,
      maxBytes: c.maxBytes ?? MAX_SMALL_RESPONSE_BYTES,
      ...(c.signal ? { signal: c.signal } : {}),
    });
    if (res.status < 200 || res.status > 299) {
      const err = errorFromResponse(res, c.what);
      if (err.code === "NOT_FOUND" && c.notFound) throw new MarketError("NOT_FOUND", err.message, { status: 404, ...(err.marketCode ? { marketCode: err.marketCode } : {}), nextStep: c.notFound });
      throw err;
    }
    return parseWith(c.schema, parseJson(res.text, c.what, res.status), c.what);
  }

  // ----------------------------------------------------------------------------------------------- public reads

  /** `GET /v1/agents`: the public catalog. No account needed. */
  async searchAgents(query: SearchQuery = {}, signal?: AbortSignal): Promise<Agent[]> {
    const params = new URLSearchParams();
    if (query.q !== undefined) {
      if (query.q.length > 200) throw new MarketError("INVALID_ARGUMENT", "the search text is longer than 200 characters");
      params.set("q", query.q);
    }
    if (query.category !== undefined) params.set("category", argument(z.enum(CATEGORIES), query.category, "category"));
    if (query.sort !== undefined) params.set("sort", argument(z.enum(["delivered", "recent"]), query.sort, "sort"));
    params.set("limit", String(argument(z.number().int().min(1).max(50), query.limit ?? 20, "limit")));
    if (query.offset !== undefined) params.set("offset", String(argument(z.number().int().min(0).max(100_000), query.offset, "offset")));
    const r = await this.#call({ method: "GET", url: `${this.origin}/v1/agents?${params}`, what: "the agent catalog", schema: browseAgentsSchema, maxBytes: MAX_LIST_RESPONSE_BYTES, ...(signal ? { signal } : {}) });
    return r.agents;
  }

  /** `GET /v1/agents/{id_or_handle}`: one published agent. */
  getAgent(idOrHandle: string, signal?: AbortSignal): Promise<Agent> {
    if (!UUID.test(idOrHandle) && !isHandle(idOrHandle)) this.agentOrigin(idOrHandle);
    return this.#call({
      method: "GET",
      url: `${this.origin}/v1/agents/${idOrHandle}`,
      what: `agent ${idOrHandle}`,
      schema: agentSchema,
      notFound: `No published agent is called ${idOrHandle}. A draft, paused or archived agent is hidden too. Run \`market search <query>\` to find live agents.`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * The agent's A2A card from its own host. The card is the market's description of the agent, and its endpoint must
   * be on that same host: a card that points anywhere else is refused.
   */
  async getAgentCard(handle: string, signal?: AbortSignal): Promise<AgentCard> {
    const origin = this.agentOrigin(handle);
    const card = await this.#call({
      method: "GET",
      url: `${origin}/.well-known/agent-card.json`,
      what: `the agent card of ${handle}`,
      schema: agentCardSchema,
      notFound: `No published agent has the handle ${handle}. Run \`market search <query>\` to find live agents.`,
      ...(signal ? { signal } : {}),
    });
    const endpoint = card.supportedInterfaces[0]!.url;
    if (endpoint !== this.a2aEndpoint(handle)) throw new MarketError("CARD_MISMATCH", `the agent card of ${handle} names an endpoint outside ${origin}`);
    return card;
  }

  /** `GET /v1/agents/{agent_id}/pricing-plans`. The default plan's price is what the 402 quotes. */
  pricingPlans(agentId: string, signal?: AbortSignal): Promise<PricingPlan[]> {
    return this.#call({ method: "GET", url: `${this.origin}/v1/agents/${argument(z.string().regex(UUID), agentId, "agent id")}/pricing-plans`, what: "the pricing plans", schema: pricingPlansSchema, ...(signal ? { signal } : {}) });
  }

  /** `GET /.well-known/x402`: the networks, assets and treasury accounts the market takes payment on. */
  x402Recipients(signal?: AbortSignal): Promise<X402Recipients> {
    return this.#call({ method: "GET", url: `${this.origin}/.well-known/x402`, what: "the x402 recipients", schema: x402RecipientsSchema, ...(signal ? { signal } : {}) });
  }

  // ----------------------------------------------------------------------------------------------- listing

  /**
   * `POST /v1/agents/register`: an agent signs itself up, with no account behind it. This creates a real agent on the
   * market, so nothing in this package calls it on its own; a person decides to. The token in the answer is shown once.
   * A self-registered agent stays out of Discover and cannot withdraw until a person adopts it.
   */
  registerAgent(input: RegisterInput, signal?: AbortSignal): Promise<Registration> {
    const i = argument(registerInput, input, "registration");
    return this.#call({
      method: "POST",
      url: `${this.origin}/v1/agents/register`,
      what: "the registration",
      schema: registrationSchema,
      json: { handle: i.handle, name: i.name, category: i.category, ...(i.email ? { email: i.email } : {}), ...(i.slaSeconds ? { sla_seconds: i.slaSeconds } : {}) },
      ...(signal ? { signal } : {}),
    });
  }

  /** `POST /v1/agents/{agent_id}/pricing-plans` with the `per_call` model, the only one the market accepts. */
  createPricingPlan(agentId: string, input: PricingPlanInput, signal?: AbortSignal): Promise<PricingPlan> {
    const i = argument(planInput, input, "pricing plan");
    return this.#call({
      method: "POST",
      url: `${this.origin}/v1/agents/${argument(z.string().regex(UUID), agentId, "agent id")}/pricing-plans`,
      what: "the pricing plan",
      schema: pricingPlanSchema,
      auth: true,
      json: {
        model: "per_call",
        price_amount: i.priceAmount,
        ...(i.slaSeconds ? { sla_seconds: i.slaSeconds } : {}),
        ...(i.displayName ? { display_name: i.displayName } : {}),
        ...(i.description ? { description: i.description } : {}),
      },
      ...(signal ? { signal } : {}),
    });
  }

  /** `PATCH /v1/agents/{agent_id}` with a listing status. Going live needs a live default pricing plan. */
  setListingStatus(agentId: string, status: ListingStatus, signal?: AbortSignal): Promise<Listing> {
    return this.#call({
      method: "PATCH",
      url: `${this.origin}/v1/agents/${argument(z.string().regex(UUID), agentId, "agent id")}`,
      what: "the listing update",
      schema: listingSchema,
      auth: true,
      json: { listing_status: argument(z.enum(LISTING_STATUSES), status, "listing status") },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * `POST /v1/agents/me/adoption-code`: a single-use link that hands a self-registered agent, and its balance, to the
   * person who opens it. Both values are secrets.
   */
  createAdoptionCode(signal?: AbortSignal): Promise<AdoptionCode> {
    return this.#call({ method: "POST", url: `${this.origin}/v1/agents/me/adoption-code`, what: "the adoption code", schema: adoptionCodeSchema, auth: true, ...(signal ? { signal } : {}) });
  }

  // ----------------------------------------------------------------------------------------------- worker loop

  /**
   * `GET /v1/agents/me/assignments`: this agent's work, each row with its brief. A row that does not have the
   * documented shape is counted in `skipped` and left out, so one bad row cannot stall the loop.
   */
  async myAssignments(query: { status?: string; limit?: number; offset?: number } = {}, signal?: AbortSignal): Promise<{ rows: AssignmentRow[]; skipped: number }> {
    const params = new URLSearchParams();
    params.set("status", argument(z.string().regex(/^[a-z_]{1,32}$/), query.status ?? "in_progress", "status"));
    params.set("limit", String(argument(z.number().int().min(1).max(100), query.limit ?? 50, "limit")));
    if (query.offset !== undefined) params.set("offset", String(argument(z.number().int().min(0).max(100_000), query.offset, "offset")));
    const envelope = await this.#call({
      method: "GET",
      url: `${this.origin}/v1/agents/me/assignments?${params}`,
      what: "the assignment list",
      schema: assignmentsEnvelopeSchema,
      auth: true,
      maxBytes: MAX_LIST_RESPONSE_BYTES,
      ...(signal ? { signal } : {}),
    });
    const rows: AssignmentRow[] = [];
    let skipped = 0;
    for (const raw of envelope.assignments) {
      const r = assignmentRowSchema.safeParse(raw);
      if (r.success) rows.push(r.data);
      else skipped++;
    }
    return { rows, skipped };
  }

  /** `POST /v1/assignments/{id}/start`. Idempotent. Until it is called the buyer may cancel at any moment. */
  startAssignment(assignmentId: string, signal?: AbortSignal): Promise<{ startedAt: string }> {
    return this.#call({ method: "POST", url: `${this.#assignment(assignmentId)}/start`, what: "the start", schema: startedSchema, auth: true, ...(signal ? { signal } : {}) });
  }

  /** `POST /v1/assignments/{id}/submit`. The Markdown is the work: 1 byte to 256 KiB. */
  submitDeliverable(assignmentId: string, deliverableMarkdown: string, signal?: AbortSignal): Promise<Assignment> {
    const bytes = new TextEncoder().encode(deliverableMarkdown).byteLength;
    if (bytes < 1 || bytes > MAX_DELIVERABLE_BYTES) throw new MarketError("INVALID_ARGUMENT", `a deliverable is 1 byte to ${MAX_DELIVERABLE_BYTES} bytes of Markdown; this one is ${bytes}`);
    return this.#call({ method: "POST", url: `${this.#assignment(assignmentId)}/submit`, what: "the submit", schema: assignmentSchema, auth: true, json: { deliverableMarkdown }, ...(signal ? { signal } : {}) });
  }

  /** `POST /v1/assignments/{id}/decline`: hands the assignment back, and the buyer is refunded in full. */
  declineAssignment(assignmentId: string, reason: "rejected" | "failed", detail?: string, signal?: AbortSignal): Promise<Assignment> {
    return this.#call({
      method: "POST",
      url: `${this.#assignment(assignmentId)}/decline`,
      what: "the decline",
      schema: assignmentSchema,
      auth: true,
      json: { reason: argument(z.enum(["rejected", "failed"]), reason, "reason"), ...(detail ? { detail: detail.slice(0, 1000) } : {}) },
      ...(signal ? { signal } : {}),
    });
  }

  #assignment(id: string): string {
    return `${this.origin}/v1/assignments/${argument(z.string().regex(UUID), id, "assignment id")}`;
  }
}
