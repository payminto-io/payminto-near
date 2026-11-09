/**
 * Operator routes (GATEWAY.md section 14.3), admin token only: merchants, payout changes, methods, fee plans and the
 * platform. In mock mode they are served by lib/mock/gateway.ts.
 */
import { z } from "zod";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { payoutChangeMessage as protocolPayoutChangeMessage, type PayoutProofScope } from "@payminto/protocol";
import { feePlanSchema, merchantMethodSchema, merchantSchema, platformFeesSchema, platformSchema, type FeePlan, type Merchant, type MerchantMethod, type Platform, type PlatformFees } from "./schemas";
import { requestJson, type RequestOptions } from "./http";

export type CreateMerchantBody = Pick<Merchant, "name" | "slug" | "payout" | "fee_plan_id"> & Partial<Pick<Merchant, "support_email" | "brand_color" | "logo_url">> & {
  /** EIP-191 proof that the payout wallet is controlled by whoever registers it. */
  payout_proof: { timestamp: number; signature: Hex };
  methods?: Omit<MerchantMethod, "merchant_id">[];
};
export type MerchantPatch = Partial<Pick<Merchant, "name" | "status" | "support_email" | "brand_color" | "logo_url" | "fee_plan_id">>;
export type PlatformPatch = Partial<Pick<Platform, "name" | "default_fee_plan_id" | "signup_mode" | "agent_budgets_for_businesses">>;
export type FeePlanBody = Pick<FeePlan, "name" | "platform_fee_bps" | "platform_fee_fixed" | "min_fee" | "max_fee">;
/** One payout change, newest first (GATEWAY.md section 15); `proven` is false only for the seeded first payout. */
export type PayoutHistoryEntry = { old_payout: Address | null; new_payout: Address; proven: boolean; signed_at?: number | null; changed_at: string };

export interface OperatorApi {
  platform(): Promise<Platform>;
  updatePlatform(patch: PlatformPatch): Promise<Platform>;
  platformFees(): Promise<PlatformFees>;
  merchants(): Promise<Merchant[]>;
  merchant(id: string): Promise<Merchant & { payout_history?: PayoutHistoryEntry[] }>;
  createMerchant(body: CreateMerchantBody): Promise<Merchant>;
  updateMerchant(id: string, patch: MerchantPatch): Promise<Merchant>;
  changePayout(id: string, body: { payout: Address; timestamp: number; signature: Hex }): Promise<Merchant>;
  methods(merchantId: string): Promise<MerchantMethod[]>;
  setMethods(merchantId: string, rows: Omit<MerchantMethod, "merchant_id">[]): Promise<MerchantMethod[]>;
  feePlans(): Promise<FeePlan[]>;
  createFeePlan(body: FeePlanBody): Promise<FeePlan>;
  updateFeePlan(id: string, patch: Partial<FeePlanBody>): Promise<FeePlan>;
}

/**
 * The message a new payout wallet signs (EIP-191 personal_sign): the protocol's payoutChangeMessage, bound to the
 * node's chain and hub (`scope`, from /v1/info). Placeholders stand in while the payout or the node info is unknown.
 */
export function payoutChangeMessage(merchantId: string, payout: string, timestamp: number, scope: PayoutProofScope | null): string {
  if (scope && isAddress(payout)) return protocolPayoutChangeMessage(merchantId, payout, timestamp, scope);
  return `Payminto payout change ${merchantId} ${payout} ${timestamp} chain ${scope?.chainId ?? "{chain}"} hub ${scope ? getAddress(scope.hub) : "{hub}"}`;
}

function listOf<T extends z.ZodType>(item: T) {
  return z.union([z.array(item), z.object({ items: z.array(item) }).transform((o) => o.items)]) as unknown as z.ZodType<z.infer<T>[]>;
}

const merchantDetailSchema = merchantSchema.extend({
  payout_history: z
    .array(
      z.object({
        old_payout: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable(),
        new_payout: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        proven: z.boolean(),
        signed_at: z.number().nullable().optional(),
        changed_at: z.string(),
      }),
    )
    .optional(),
}) as unknown as z.ZodType<Merchant & { payout_history?: PayoutHistoryEntry[] }>;

const METHOD_ORDER = ["wallet", "deposit", "x402", "voucher"];
export function byMethodOrder<T extends { method: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));
}

export class HttpOperatorApi implements OperatorApi {
  constructor(
    private readonly nodeUrl: string,
    private readonly token: string,
  ) {}
  private req<T>(path: string, schema: z.ZodType<T>, init: RequestOptions = {}) {
    return requestJson(this.nodeUrl, path, schema, { ...init, token: this.token });
  }
  private send<T>(method: string, path: string, schema: z.ZodType<T>, body: unknown) {
    return this.req(path, schema, { method, body: JSON.stringify(body) });
  }
  platform() {
    return this.req("/v1/platform", platformSchema);
  }
  updatePlatform(patch: PlatformPatch) {
    return this.send("PATCH", "/v1/platform", platformSchema, patch);
  }
  platformFees() {
    return this.req("/v1/platform/fees", platformFeesSchema);
  }
  merchants() {
    return this.req("/v1/merchants", listOf(merchantSchema));
  }
  merchant(id: string) {
    return this.req(`/v1/merchants/${encodeURIComponent(id)}`, merchantDetailSchema);
  }
  /**
   * The node takes the payout as its proof object ({payout, timestamp, signature}) and sets methods through their own
   * route, so the wizard's one body becomes a create followed by a methods PUT for the new merchant.
   */
  async createMerchant(body: CreateMerchantBody) {
    const { payout, payout_proof, methods, ...profile } = body;
    const m = await this.send("POST", "/v1/merchants", merchantSchema, { ...profile, payout: { payout, ...payout_proof } });
    if (methods?.length) await this.setMethods(m.id, methods);
    return m;
  }
  updateMerchant(id: string, patch: MerchantPatch) {
    return this.send("PATCH", `/v1/merchants/${encodeURIComponent(id)}`, merchantSchema, patch);
  }
  changePayout(id: string, body: { payout: Address; timestamp: number; signature: Hex }) {
    return this.send("POST", `/v1/merchants/${encodeURIComponent(id)}/payout`, merchantSchema, body);
  }
  // Methods always read in checkout order (people first, then agents), whatever order the node stores them in.
  // GATEWAY.md section 15: on a node with several merchants the admin token must also name the merchant in Merchant-Id here.
  methods(merchantId: string) {
    return this.req(`/v1/merchants/${encodeURIComponent(merchantId)}/methods`, listOf(merchantMethodSchema), { headers: { "Merchant-Id": merchantId } }).then(byMethodOrder);
  }
  setMethods(merchantId: string, rows: Omit<MerchantMethod, "merchant_id">[]) {
    return this.req(`/v1/merchants/${encodeURIComponent(merchantId)}/methods`, listOf(merchantMethodSchema), {
      method: "PUT",
      body: JSON.stringify({ methods: rows }),
      headers: { "Merchant-Id": merchantId },
    }).then(byMethodOrder);
  }
  feePlans() {
    return this.req("/v1/fee-plans", listOf(feePlanSchema));
  }
  createFeePlan(body: FeePlanBody) {
    return this.send("POST", "/v1/fee-plans", feePlanSchema, body);
  }
  updateFeePlan(id: string, patch: Partial<FeePlanBody>) {
    return this.send("PATCH", `/v1/fee-plans/${encodeURIComponent(id)}`, feePlanSchema, patch);
  }
}
