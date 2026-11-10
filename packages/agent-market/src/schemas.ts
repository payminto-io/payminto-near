/**
 * The shapes of the market's answers, as far as this package reads them.
 *
 * The market is a third party, so every field is untrusted: identifiers must match a strict pattern, free text is cut
 * to a fixed length, lists are bounded, and unknown fields are dropped. Text written by buyers or builders (titles,
 * briefs, messages, descriptions) is data. Nothing in this package ever treats it as an instruction.
 *
 * The catalog routes answer in snake_case and the worker routes in camelCase; both are kept as the market sends them.
 */
import { z } from "zod";
import { MAX_JOB_TEXT_CHARS, MAX_JOB_TITLE_CHARS, MAX_MESSAGE_CHARS, MAX_QUOTE_TIMEOUT_SECONDS } from "./constants.ts";
import { Secret } from "./errors.ts";

// ------------------------------------------------------------------------------------------------- primitives

/** Free text from another party, cut to `max` characters. */
const text = (max: number) => z.string().transform((s) => (s.length > max ? s.slice(0, max) : s));

const uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "must be a UUID");
/** A machine word such as a status or a category. The market may add values, so the set is open but the shape is not. */
const word = z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/, "must be a short lowercase word");
const timestamp = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be a timestamp");
const count = z.number().int().min(0).max(2_147_483_647);
const tags = z.array(text(80)).max(64);
const link = z.string().min(1).max(2048);

/**
 * A handle is a DNS label under the market's host: 3 to 30 characters, a lowercase letter first, then lowercase
 * letters, digits and hyphens, no trailing hyphen and no `--` in positions 3 and 4.
 */
export const HANDLE = /^[a-z](?!.--)[a-z0-9-]{1,28}[a-z0-9]$/;
export const isHandle = (v: unknown): v is string => typeof v === "string" && HANDLE.test(v);
export const handleSchema = z.string().regex(HANDLE, "must be a market handle");

/** A price in whole currency units as the market writes it, for example "12.00". */
export const priceSchema = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, "must be a decimal price");
const decimal = z.string().regex(/^\d{1,24}(\.\d{1,18})?$/, "must be a decimal amount");

/** A whole number of atomic units as a canonical decimal string, positive and within u128. */
export const atomicSchema = z
  .string()
  .regex(/^[1-9]\d{0,38}$/, "must be a positive whole number of atomic units")
  .refine((v) => /^\d{1,39}$/.test(v) && BigInt(v) <= 2n ** 128n - 1n, "must fit in u128");
/** The same, with zero allowed. Used for limits and running totals. */
export const atomicOrZeroSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,38})$/, "must be a whole number of atomic units")
  .refine((v) => /^\d{1,39}$/.test(v) && BigInt(v) <= 2n ** 128n - 1n, "must fit in u128");

// ------------------------------------------------------------------------------------------------- catalog

export const agentSchema = z.object({
  agent_id: uuid,
  owner_account_id: uuid,
  handle: handleSchema,
  name: text(200),
  description: text(2_000).nullish(),
  category: word,
  tags,
  runtime: word,
  listing_status: word,
  delivered_jobs: count,
  /** Accepted over all finished jobs, 0 to 100. */
  success_rate: z.number().int().min(0).max(100).nullish(),
  sla_seconds: count,
  /** Derived by the market: `available`, `paused`, `suspended` or `unavailable_funding`. */
  availability: word,
  /** Whether the agent can take a job right now. Absent on some surfaces. */
  available_now: z.boolean().nullish(),
  payable_with: z.array(z.string().regex(/^[A-Za-z0-9]{1,16}$/)).max(8).nullish(),
  builder: z
    .object({ display_name: text(200), verification: z.object({ level: word }) })
    .nullish(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type Agent = z.infer<typeof agentSchema>;

export const browseAgentsSchema = z.object({ agents: z.array(agentSchema).max(50) });

/** The A2A agent card the market serves at `/.well-known/agent-card.json` on the agent's host. */
export const agentCardSchema = z.object({
  name: text(200),
  description: text(4_000),
  version: z.string().max(64).optional(),
  supportedInterfaces: z
    .array(z.object({ url: link, protocolBinding: z.string().max(32), protocolVersion: z.string().max(16).optional() }))
    .min(1)
    .max(8),
  capabilities: z.object({ streaming: z.boolean().optional(), pushNotifications: z.boolean().optional() }).optional(),
  defaultInputModes: z.array(z.string().max(100)).max(16).optional(),
  defaultOutputModes: z.array(z.string().max(100)).max(16).optional(),
  skills: z
    .array(z.object({ id: z.string().max(100), name: text(200), description: text(4_000).optional(), tags: tags.optional() }))
    .max(32)
    .optional(),
  provider: z.object({ organization: text(200), url: link.optional() }).optional(),
  documentationUrl: link.optional(),
});
export type AgentCard = z.infer<typeof agentCardSchema>;

export const pricingPlanSchema = z.object({
  pricing_plan_id: uuid,
  agent_id: uuid,
  model: word,
  /** Whole currency units per call, paid 1:1 in USDC. */
  price_amount: priceSchema,
  is_default: z.boolean(),
  listing_status: word,
  sla_seconds: count.nullish(),
  display_name: text(200).nullish(),
  description: text(2_000).nullish(),
});
export type PricingPlan = z.infer<typeof pricingPlanSchema>;
export const pricingPlansSchema = z.array(pricingPlanSchema).max(16);

/** `GET /.well-known/x402`: where the market takes payment. */
export const x402RecipientsSchema = z.object({
  x402Version: z.number().int(),
  recipients: z.array(z.object({ network: z.string().max(64), asset: z.string().max(128), payTo: z.string().max(128) })).max(16),
});
export type X402Recipients = z.infer<typeof x402RecipientsSchema>;

// ------------------------------------------------------------------------------------------------- listing

/** `POST /v1/agents/register`. The token is in this answer and nowhere else, so it is wrapped before anything can log it. */
export const registrationSchema = z.object({
  agentId: uuid,
  accountId: uuid,
  handle: handleSchema,
  apiToken: z
    .string()
    .regex(/^aat_[A-Za-z0-9]{16,128}$/, "must be an agent token")
    .transform((v) => new Secret(v)),
  tokenPrefix: z.string().max(32),
});
export type Registration = z.infer<typeof registrationSchema>;

/** What this package keeps from the owner view a PATCH answers with. The webhook fields are dropped on purpose. */
export const listingSchema = z.object({ agent_id: uuid, handle: handleSchema, name: text(200), listing_status: word });
export type Listing = z.infer<typeof listingSchema>;

/** Whoever opens the link owns the agent and its balance, so the code and the link are wrapped like the token. */
export const adoptionCodeSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(128)
    .transform((v) => new Secret(v)),
  adoptionUrl: link.transform((v) => new Secret(v)),
  expiresAt: timestamp,
});
export type AdoptionCode = z.infer<typeof adoptionCodeSchema>;

// ------------------------------------------------------------------------------------------------- worker loop

export const attachmentSchema = z.object({
  id: uuid,
  filename: text(255),
  contentType: z.string().max(200),
  byteSize: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const assignmentSchema = z.object({
  assignmentId: uuid,
  jobId: uuid,
  workerAgentId: uuid,
  /** `in_progress`, `submitted`, `accepted`, `disputed`, `dispute_resolved` or `cancelled`. */
  status: word,
  escrowAmount: decimal,
  escrowToken: z.string().regex(/^[A-Za-z0-9]{1,16}$/),
  slaSeconds: count,
  slaDeadlineAt: timestamp,
  startedAt: timestamp.nullish(),
  submittedAt: timestamp.nullish(),
  /** Set once a version was delivered. Its value is the market's own path and is not used here. */
  deliverableUrl: link.nullish(),
  cancelReason: word.nullish(),
});
export type Assignment = z.infer<typeof assignmentSchema>;

/** The brief as the market sends it. The buyer wrote the title and the description. */
export const jobBriefFields = z.object({
  jobId: uuid,
  title: z.string(),
  description: z.string(),
  tags,
  /** `standard`, `instant` or `competition`. */
  jobKind: word,
  status: word,
  attachments: z.array(attachmentSchema).max(50),
});
const jobBriefSchema = jobBriefFields.transform((j) => ({
  ...j,
  title: j.title.slice(0, MAX_JOB_TITLE_CHARS),
  description: j.description.slice(0, MAX_JOB_TEXT_CHARS),
  /** True when the brief was longer than this package keeps. */
  descriptionTruncated: j.description.length > MAX_JOB_TEXT_CHARS,
}));

export const latestMessageFields = z.object({
  /** `buyer` or `worker`. */
  senderSide: word,
  body: z.string(),
  /** True when the market itself cut the body; the thread holds the rest. */
  truncated: z.boolean(),
  createdAt: timestamp,
});
const latestMessageSchema = latestMessageFields.transform((m) => ({ ...m, body: m.body.slice(0, MAX_MESSAGE_CHARS), truncated: m.truncated || m.body.length > MAX_MESSAGE_CHARS }));

/** One row of `GET /v1/agents/me/assignments`: the assignment, its brief and the newest thread message. */
export const assignmentRowSchema = z.object({
  assignment: assignmentSchema,
  job: jobBriefSchema,
  latestMessage: latestMessageSchema.nullish(),
});
export type AssignmentRow = z.infer<typeof assignmentRowSchema>;

/** Rows are validated one by one, so a single malformed row does not hide the others. */
export const assignmentsEnvelopeSchema = z.object({ assignments: z.array(z.unknown()).max(100) });

export const startedSchema = z.object({ startedAt: timestamp });

// ------------------------------------------------------------------------------------------------- webhooks

const webhookBase = { job_id: uuid.nullish(), assignment_id: uuid };

export const webhookEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("hire.created"),
    ...webhookBase,
    hire_id: uuid.nullish(),
    title: text(MAX_JOB_TITLE_CHARS),
    description: text(MAX_JOB_TEXT_CHARS),
    tags: tags.optional(),
    amount: decimal,
    token: z.string().regex(/^[A-Za-z0-9]{1,16}$/),
    sla_seconds: count,
    sla_deadline_at: timestamp,
    kind: word.optional(),
  }),
  z.object({ event: z.literal("hire.accepted"), ...webhookBase }),
  z.object({ event: z.literal("hire.changes_requested"), ...webhookBase }),
  z.object({ event: z.literal("hire.refunded"), ...webhookBase, reason: word.optional() }),
  z.object({ event: z.literal("message.created"), ...webhookBase }),
  z.object({ event: z.literal("webhook.ping"), agent_id: uuid.optional() }),
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

// ------------------------------------------------------------------------------------------------- x402 quote

/** A CAIP-2 network name such as `near:mainnet` or `eip155:8453`. */
const caip2 = z.string().regex(/^[a-z0-9-]{3,8}:[A-Za-z0-9_-]{1,32}$/, "must be a CAIP-2 network");
const chainAddress = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "must be an account or contract address");

/**
 * One `accepts` row of the market's 402, scheme `exact`. Strict: a row with a field this package does not know is not
 * signed. `extra` is the one optional field x402 v2 defines; it changes nothing that is signed here and is not read.
 */
export const exactRequirementSchema = z.strictObject({
  extra: z.record(z.string(), z.unknown()).optional(),
  scheme: z.literal("exact"),
  network: caip2,
  /** The token contract: an account id on NEAR. */
  asset: chainAddress,
  /** The price in atomic units of `asset`. */
  amount: atomicSchema,
  /** The market's treasury account. Never the agent's own account. */
  payTo: chainAddress,
  /** How long the payment must stay valid: the job window plus ten minutes. */
  maxTimeoutSeconds: z.number().int().min(1).max(MAX_QUOTE_TIMEOUT_SECONDS),
});
export type ExactRequirement = z.infer<typeof exactRequirementSchema>;

export const paymentChallengeSchema = z.object({
  x402Version: z.number().int(),
  error: text(300).optional(),
  accepts: z.array(z.unknown()).max(16),
});

// ------------------------------------------------------------------------------------------------- A2A answers

export const rpcErrorSchema = z.object({ error: z.object({ code: z.number().int(), message: text(300) }) });

export const taskSchema = z.object({
  /** The only credential for reading the task. */
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  contextId: z.string().max(128).optional(),
  status: z.object({ state: z.string().regex(/^[A-Z_]{1,40}$/), timestamp: timestamp.optional() }),
  artifacts: z
    .array(
      z.object({
        name: text(200).optional(),
        /** Text and file links only; raw base64 parts are dropped. The text is the other agent's work, and it is data. */
        parts: z.array(z.object({ text: text(262_144).optional(), url: link.optional() })).max(64),
      }),
    )
    .max(32)
    .optional(),
});
export type Task = z.infer<typeof taskSchema>;
