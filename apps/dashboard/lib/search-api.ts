/**
 * The search routes (docs/PRODUCT.md section 10.13) through the dashboard's own `/api` path.
 */
import { requestJson } from "./http";
import { recentSchema, searchResponseSchema, type RecordType, type SearchItem, type SearchResponse } from "./search";
import { z } from "zod";

export interface SearchApi {
  search(q: string, opts?: { types?: RecordType[] | null; limit?: number; merchantId?: string | null; signal?: AbortSignal }): Promise<SearchResponse>;
  recent(): Promise<SearchItem[]>;
  record(item: { type: string; id: string; title: string; href: string }): Promise<void>;
}

export class HttpSearchApi implements SearchApi {
  constructor(
    private readonly base = "/api",
    private readonly token: string | null = null,
  ) {}
  search(q: string, opts: { types?: RecordType[] | null; limit?: number; merchantId?: string | null; signal?: AbortSignal } = {}) {
    const sp = new URLSearchParams({ q });
    if (opts.types?.length) sp.set("types", opts.types.join(","));
    sp.set("limit", String(opts.limit ?? 8));
    if (opts.merchantId) sp.set("merchant_id", opts.merchantId);
    return requestJson(this.base, `/v1/search?${sp.toString()}`, searchResponseSchema, { token: this.token, signal: opts.signal });
  }
  recent() {
    // The recovery key has no user to remember items for.
    if (this.token) return Promise.resolve([]);
    return requestJson(this.base, "/v1/search/recent", recentSchema);
  }
  async record(item: { type: string; id: string; title: string; href: string }) {
    if (this.token) return;
    await requestJson(this.base, "/v1/search/recent", z.unknown(), { method: "POST", body: JSON.stringify(item) });
  }
}
