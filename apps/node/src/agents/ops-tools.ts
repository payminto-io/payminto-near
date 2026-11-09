import { createHash } from "node:crypto";
import type { ToolSpec } from "@payminto/models";
import { callMerchantTool, MERCHANT_TOOLS, MerchantDesk, merchantToolJsonSchema } from "@payminto/sdk";
import type { ApiKeyService } from "../gateway/keys.ts";
import type { BusinessPermission } from "../auth/permissions.ts";

/**
 * What an ops run's credential may do: read payments, reports and blocked payers, create links and request refunds.
 * Never approve, issue or submit a refund, change the business, or manage keys and webhooks.
 */
export const RUN_SCOPED_PERMISSIONS: readonly BusinessPermission[] = ["payments.read", "links.write", "refunds.request", "screening.read"];

/** In-process origin the run's gateway client talks to; requests never leave the node. */
export const IN_PROCESS_URL = "http://payminto.internal";

/** Largest tool result handed back to the model. */
const MAX_TOOL_RESULT = 50_000;

export type ToolOutcome = { isError: boolean; content: string };

export type OpsToolbox = {
  specs: ToolSpec[];
  call(name: string, input: Record<string, unknown>, ordinal: number): Promise<ToolOutcome>;
  close(): void;
};

export type OpsToolFactory = (o: { merchantId: string; runId: string; attempt: number; allowed: readonly string[] | null; expiresAt: Date }) => Promise<OpsToolbox>;

/** Idempotency key of a tool call: the run and the call's position, so a retried attempt repeats no side effect. */
export function toolIdempotencyKey(runId: string, ordinal: number): string {
  return `agent-${createHash("sha256").update(`${runId}\n${ordinal}`).digest("hex").slice(0, 40)}`;
}

/**
 * The seven merchant tools for one ops run, over the gateway API in-process with a run-scoped API key
 * (RUN_SCOPED_PERMISSIONS) that is revoked when the attempt ends and expires on its own.
 */
export function merchantToolFactory(o: { keys: ApiKeyService; fetch: () => typeof fetch }): OpsToolFactory {
  return async ({ merchantId, runId, allowed, expiresAt }) => {
    const key = o.keys.createRunScoped(merchantId, runId, RUN_SCOPED_PERMISSIONS, expiresAt);
    try {
      const desk = await MerchantDesk.connect({ nodeUrl: IN_PROCESS_URL, apiKey: key.secret, fetch: o.fetch() });
      const tools = MERCHANT_TOOLS.filter((t) => !allowed || allowed.includes(t.name));
      const who = desk.business.name;
      return {
        specs: tools.map((t) => ({ name: t.name, description: t.description(who), inputSchema: merchantToolJsonSchema(t) })),
        async call(name, input, ordinal) {
          if (!tools.some((t) => t.name === name)) return { isError: true, content: `The tool ${name} is not available to this agent.` };
          const r = await callMerchantTool(desk, name, input, { idempotencyKey: toolIdempotencyKey(runId, ordinal) });
          return { isError: r.isError, content: r.text.length > MAX_TOOL_RESULT ? `${r.text.slice(0, MAX_TOOL_RESULT)}\n[truncated]` : r.text };
        },
        close: () => o.keys.revokeRunScoped(key.id),
      };
    } catch (err) {
      o.keys.revokeRunScoped(key.id);
      throw err;
    }
  };
}
