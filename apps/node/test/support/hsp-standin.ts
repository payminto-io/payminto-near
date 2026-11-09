/**
 * Local stand-in for HashKey's HSP Agentic Payment MCP server (docs/GATEWAY.md section 17), for tests only.
 * Same transport (Streamable HTTP at /, GET /health), the same eight tools and the same result shapes as HashKey's
 * guide describes, backed by the local anvil chain: submit_payment really broadcasts the payer's EIP-3009
 * transferWithAuthorization on the test token, so the node's deposit watcher sees a real transfer into the forwarder.
 * It never talks to HashKey.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { getAddress, toHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { eip3009Abi, hspBaseUnits } from "@payminto/protocol";
import type { Anvil } from "../helpers.ts";

export type HspStandinOptions = {
  anvil: Anvil;
  token: Address;
  /** The token's EIP-712 domain name and version. */
  tokenDomain: { name: string; version: string };
  /** Key that broadcasts submitted payments (HSP's gateway wallet; pays the gas). */
  broadcasterKey: Hex;
  /** HSP's network name in get_chain_config (default "hashkey-local"). */
  network?: string;
  /** Seconds a prepare_payment quote stays valid (HashKey: 300). */
  quoteTtlSec?: number;
};

type Order = { flow_id: string; payment_request_id: string; merchant_name: string; pay_to: Address; value: string; cart: Record<string, unknown> };
type Quote = { id: string; flow_id: string; payer: Address; raw: bigint; expires: number; message: Record<string, string>; cart_hash: string; submitted: boolean };
type Payment = { flow_id: string; quote_id: string; tx: Hex; queries: number; status: string; reason: string | null };

export type HspStandin = {
  /** The MCP endpoint, like https://mcp-qa.hashkeymerchant.com/. */
  url: string;
  /** Tool calls in order, for assertions. */
  calls: string[];
  orders: Map<string, Order>;
  /** Answer HTTP 403 to everything (an egress IP that is not allowlisted). */
  forbid: boolean;
  /** Make the next submit_payment fail with this HSP error code (30043: quote expired). */
  failNextSubmit: number | null;
  /** What get_chain_config lists; tests change it to simulate another network or token. */
  listed: { chainId: number; token: Address };
  close(): Promise<void>;
};

const X402_METHOD = "https://www.x402.org/";

export async function startHspStandin(o: HspStandinOptions): Promise<HspStandin> {
  const chainId = o.anvil.chain.id;
  const network = o.network ?? "hashkey-local";
  const orders = new Map<string, Order>();
  const byCart = new Map<string, string>();
  const quotes = new Map<string, Quote>();
  const payments = new Map<string, Payment>();
  const broadcaster = o.anvil.wallet(o.broadcasterKey);
  const state: HspStandin = {
    url: "",
    calls: [],
    orders,
    forbid: false,
    failNextSubmit: null,
    listed: { chainId, token: o.token },
    close: async () => {},
  };

  const ok = (v: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v as Record<string, unknown> });
  const fail = (code: number, message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] });
  const tool = (name: string, fn: (a: any) => Promise<CallToolResult> | CallToolResult) => (a: unknown) => {
    state.calls.push(name);
    return fn(a);
  };

  const build = () => {
    const server = new McpServer({ name: "hsp-standin", version: "0.0.0" });
    server.registerTool("get_chain_config", { description: "Supported networks and tokens", inputSchema: {} }, tool("get_chain_config", () =>
      ok({ networks: [{ network, chain_id: state.listed.chainId, tokens: [{ symbol: "USDC", address: state.listed.token, decimals: 6, payment_protocol: "eip3009" }] }] }),
    ));
    server.registerTool(
      "create_order",
      { description: "Create an order", inputSchema: { merchant_name: z.string().min(1), pay_to: z.string(), cart_mandate: z.record(z.string(), z.unknown()) } },
      tool("create_order", (a: { merchant_name: string; pay_to: string; cart_mandate: any }) => {
        const c = a.cart_mandate?.contents;
        if ("merchant_authorization" in (a.cart_mandate ?? {})) return fail(10001, "merchant_authorization is managed server-side");
        if (!c?.id || !c.cart_expiry || Number.isNaN(Date.parse(c.cart_expiry))) return fail(10002, "contents.id and an RFC3339 contents.cart_expiry are required");
        const methods = c.payment_request?.method_data;
        const total = c.payment_request?.details?.total?.amount;
        if (!Array.isArray(methods) || !methods.length) return fail(10003, "method_data is required");
        for (const m of methods) {
          if (!m.supported_methods?.includes(X402_METHOD) || m.data?.x402Version !== 2) return fail(10004, "each method needs x402 v2");
          if (m.data.network !== network || getAddress(m.data.token) !== getAddress(o.token)) return fail(10005, "network and token must come from get_chain_config");
          m.data.pay_to = a.pay_to; // the server overrides pay_to
        }
        if (total?.currency !== "USD" || !/^\d+(\.\d+)?$/.test(total?.value ?? "")) return fail(10006, "amount currency must be USD");
        const existing = byCart.get(c.id);
        if (existing) {
          const ord = orders.get(existing)!;
          return ok({ flow_id: ord.flow_id, payment_request_id: ord.payment_request_id, payment_url: `https://pay.example.test/flow/${ord.flow_id}` });
        }
        const flow_id = `flow_${randomUUID()}`;
        const order: Order = { flow_id, payment_request_id: `pr_${randomUUID()}`, merchant_name: a.merchant_name, pay_to: getAddress(a.pay_to), value: total.value, cart: c };
        orders.set(flow_id, order);
        byCart.set(c.id, flow_id);
        return ok({ flow_id, payment_request_id: order.payment_request_id, payment_url: `https://pay.example.test/flow/${flow_id}` });
      }),
    );
    server.registerTool("get_order", { description: "Read an order", inputSchema: { flow_id: z.string() } }, tool("get_order", (a: { flow_id: string }) => {
      const ord = orders.get(a.flow_id);
      return ord ? ok({ flow_id: ord.flow_id, payment_request_id: ord.payment_request_id, pay_to: ord.pay_to, gas_fee_advanced: true }) : fail(20001, "order not found");
    }));
    server.registerTool(
      "prepare_payment",
      { description: "Lock a quote", inputSchema: { flow_id: z.string(), payer: z.string(), protocol: z.string() } },
      tool("prepare_payment", (a: { flow_id: string; payer: string; protocol: string }) => {
        const ord = orders.get(a.flow_id);
        if (!ord) return fail(20001, "order not found");
        if (a.protocol !== "eip3009") return fail(20002, "unsupported protocol");
        const now = Math.floor(Date.now() / 1000);
        const raw = hspBaseUnits(ord.value, 6);
        const id = `q_${randomUUID()}`;
        const message = {
          from: getAddress(a.payer),
          to: ord.pay_to,
          value: raw.toString(),
          validAfter: "0",
          validBefore: String(now + 3600),
          nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
        };
        const cart_hash = `0x${createHash("sha256").update(JSON.stringify(ord.cart)).digest("hex")}`;
        const expires = now + (o.quoteTtlSec ?? 300);
        quotes.set(id, { id, flow_id: ord.flow_id, payer: getAddress(a.payer), raw, expires, message, cart_hash, submitted: false });
        return ok({
          eip712: {
            domain: { name: o.tokenDomain.name, version: o.tokenDomain.version, chainId, verifyingContract: o.token },
            types: {
              EIP712Domain: [
                { name: "name", type: "string" },
                { name: "version", type: "string" },
                { name: "chainId", type: "uint256" },
                { name: "verifyingContract", type: "address" },
              ],
              TransferWithAuthorization: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "validAfter", type: "uint256" },
                { name: "validBefore", type: "uint256" },
                { name: "nonce", type: "bytes32" },
              ],
            },
            primaryType: "TransferWithAuthorization",
            message,
          },
          cart_hash,
          token_total_raw: raw.toString(),
          pay_to: ord.pay_to,
          payer: getAddress(a.payer),
          payment_request_id: ord.payment_request_id,
          payment_payload: { x402Version: 2, scheme: "exact", network, quote_id: id },
          payment_mandate_contents: { payment_mandate_id: `pm_${id}`, payment_details_id: ord.payment_request_id, payer: getAddress(a.payer) },
          quote_expires_at: new Date(expires * 1000).toISOString(),
        });
      }),
    );
    server.registerTool(
      "finalize_payment",
      { description: "Build the payment mandate", inputSchema: { signature: z.string(), payment_payload: z.unknown(), payment_mandate_contents: z.unknown(), cart_hash: z.string() } },
      tool("finalize_payment", (a: { signature: string; payment_payload: { quote_id?: string }; payment_mandate_contents: unknown; cart_hash: string }) => {
        const q = quotes.get(a.payment_payload?.quote_id ?? "");
        if (!q || q.cart_hash !== a.cart_hash) return fail(30010, "payment_payload or cart_hash does not match a quote");
        return ok({ payment_mandate_json: JSON.stringify({ quote_id: q.id, signature: a.signature, contents: a.payment_mandate_contents }) });
      }),
    );
    server.registerTool("estimate_fee", { description: "Estimate gas", inputSchema: { flow_id: z.string().optional() } }, tool("estimate_fee", () => ok({ gas_fee: "0", gas_fee_advanced: true })));
    server.registerTool(
      "submit_payment",
      { description: "Submit a payment mandate", inputSchema: { payment_mandate_json: z.unknown() } },
      tool("submit_payment", async (a: { payment_mandate_json: string }) => {
        const m = JSON.parse(a.payment_mandate_json) as { quote_id: string; signature: Hex };
        const q = quotes.get(m.quote_id);
        if (!q) return fail(30011, "unknown payment mandate");
        if (state.failNextSubmit !== null) {
          const code = state.failNextSubmit;
          state.failNextSubmit = null;
          return fail(code, "quote expired, prepare again");
        }
        if (Math.floor(Date.now() / 1000) >= q.expires) return fail(30043, "quote expired, prepare again");
        if (q.submitted) return fail(30044, "this payment mandate was already submitted");
        q.submitted = true;
        const tx = await broadcaster.writeContract({
          address: o.token,
          abi: eip3009Abi,
          functionName: "transferWithAuthorization",
          args: [q.message.from as Address, q.message.to as Address, q.raw, 0n, BigInt(q.message.validBefore!), q.message.nonce as Hex, m.signature],
        });
        payments.set(q.flow_id, { flow_id: q.flow_id, quote_id: q.id, tx, queries: 0, status: "payment-submitted", reason: null });
        return ok({ status: "payment-submitted", flow_id: q.flow_id });
      }),
    );
    server.registerTool(
      "query_payment",
      { description: "Payment status", inputSchema: { flow_id: z.string().optional(), payment_request_id: z.string().optional(), expected_merchant_name: z.string() } },
      tool("query_payment", async (a: { flow_id?: string; payment_request_id?: string; expected_merchant_name: string }) => {
        const ord = a.flow_id ? orders.get(a.flow_id) : [...orders.values()].find((x) => x.payment_request_id === a.payment_request_id);
        const p = ord ? payments.get(ord.flow_id) : undefined;
        if (!ord || !p) return fail(20003, "payment not found");
        const r = await o.anvil.pub.getTransactionReceipt({ hash: p.tx }).catch(() => null);
        if (r && r.status !== "success") (p.status = "payment-failed"), (p.reason = "transfer reverted");
        else if (r && p.status !== "payment-finalized") {
          // One step per query once mined: included, then safe (half the confirmations), then finalized.
          p.status = p.status === "payment-submitted" || p.status === "payment-verified" || p.status === "payment-processing" ? "payment-included" : p.status === "payment-included" ? "payment-safe" : "payment-finalized";
        }
        p.queries++;
        return ok({
          flow_id: ord.flow_id,
          payment_request_id: ord.payment_request_id,
          attribution_verified: a.expected_merchant_name === ord.merchant_name,
          gas_fee_advanced: true,
          payment: { status: p.status, status_reason: p.reason, tx_signature: p.tx },
        });
      }),
    );
    return server;
  };

  const app = new Hono();
  app.use("*", async (c, next) => (state.forbid ? c.text("Forbidden", 403) : next()));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.on(["GET", "DELETE"], "/", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST" }, id: null }, 405));
  app.post("/", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = build();
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s as Server));
  });
  state.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  state.close = () =>
    new Promise<void>((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections?.();
    });
  return state;
}
