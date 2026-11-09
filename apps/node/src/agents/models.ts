/**
 * The node's seam onto the model layer (docs/AGENTS.md section 3). Every provider adapter, the catalogue and the
 * connection checks come from `@payminto/models`, the same layer the agent runtime uses, so a business can run its
 * agents on any provider it holds a key for. What stays here is node glue: the three entry points as one replaceable
 * object (tests swap in a scripted model or a mock fetch) and the coercion of any thrown value to a ModelError.
 */
import { createModelClient, listModels, ModelError, verifyConnection, type ClientOptions, type ConnectionSpec, type ModelClient, type VerifyResult } from "@payminto/models";

/** The model layer as the node uses it; tests replace parts of it. */
export type ModelLayer = {
  createModelClient(c: ConnectionSpec, o?: ClientOptions): ModelClient;
  verifyConnection(c: ConnectionSpec, o?: ClientOptions & { signal?: AbortSignal }): Promise<VerifyResult>;
  listModels(c: Omit<ConnectionSpec, "model">, o?: ClientOptions & { signal?: AbortSignal }): Promise<string[] | null>;
};

/** The real layer. Clients never retry on their own: the worker owns retries and backoff (honouring Retry-After). */
export const defaultModelLayer: ModelLayer = {
  createModelClient: (c, o) => createModelClient(c, { ...o, maxRetries: 0 }),
  verifyConnection: (c, o) => verifyConnection(c, { ...o, maxRetries: 0 }),
  listModels: (c, o) => listModels(c, { ...o, maxRetries: 0 }),
};

/** Binds an HTTP client into every call of a layer, unless the call brings its own (tests point providers at mocks). */
export function withModelFetch(layer: ModelLayer, f: typeof fetch): ModelLayer {
  return {
    createModelClient: (c, o) => layer.createModelClient(c, { ...o, fetch: o?.fetch ?? f }),
    verifyConnection: (c, o) => layer.verifyConnection(c, { ...o, fetch: o?.fetch ?? f }),
    listModels: (c, o) => layer.listModels(c, { ...o, fetch: o?.fetch ?? f }),
  };
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError");
}

/** Any thrown value as a ModelError (the adapters already throw ModelError; this covers aborts and the unexpected). */
export function asModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  if (isAbort(err)) return new ModelError("timeout", "the model request was aborted");
  return new ModelError("unknown", err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300));
}
