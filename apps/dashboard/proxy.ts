import { NextResponse, type NextRequest } from "next/server";
import { MOCK_MODE, NODE_URL } from "@/lib/config";
import { apiTarget, x402Target } from "@/lib/proxy-match";

/**
 * One link for people and agents (GATEWAY.md section 5): a browser gets the hosted page, anything else is rewritten to
 * the node's x402 route. A rewrite forwards every request header (PAYMENT-SIGNATURE included) and returns the node's
 * status and headers (PAYMENT-REQUIRED, PAYMENT-RESPONSE) unchanged.
 * NODE_INTERNAL_URL is read at runtime, for deployments where the dashboard reaches the node on a private address.
 */
const NODE = (process.env.NODE_INTERNAL_URL || NODE_URL).replace(/\/+$/, "");

export function proxy(request: NextRequest) {
  // The dashboard's own API path (PRODUCT.md section 10.1): forwarded to the node so the session cookie is
  // first-party. A rewrite passes Cookie, Set-Cookie, Origin and the body through unchanged, and streams SSE.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const path = apiTarget(request.nextUrl.pathname);
    if (MOCK_MODE || !path) {
      return NextResponse.json(
        MOCK_MODE
          ? { error: { code: "MOCK_MODE", message: "This dashboard runs on demo data (NEXT_PUBLIC_MOCK), so there is no server behind /api." } }
          : { error: { code: "NOT_FOUND", message: "No such API route." } },
        { status: MOCK_MODE ? 503 : 404 },
      );
    }
    const url = new URL(`${NODE}${path}`);
    url.search = request.nextUrl.search;
    return NextResponse.rewrite(url);
  }
  const target = x402Target(request.nextUrl.pathname, request.headers);
  if (!target) {
    const res = NextResponse.next();
    // The same URL answers HTML or a 402 depending on these headers, so shared caches must keep them apart.
    res.headers.set("Vary", "Accept, Payment-Signature");
    return res;
  }
  if (MOCK_MODE) {
    return NextResponse.json(
      { error: { code: "MOCK_MODE", message: "This dashboard runs on mock data (NEXT_PUBLIC_MOCK), so there is no node to answer x402 requests." } },
      { status: 503 },
    );
  }
  const url = new URL(`${NODE}${target}`);
  url.search = request.nextUrl.search;
  return NextResponse.rewrite(url);
}

/**
 * Next.js strips its router headers (RSC, Next-Router-*) before the proxy function runs, so the router's own
 * navigation requests are excluded here, where the matcher still sees the original headers. Matchers must be literal.
 */
export const config = {
  matcher: [
    "/api/:path*",
    {
      source: "/l/:slug",
      missing: [
        { type: "header", key: "rsc" },
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "next-router-state-tree" },
        { type: "header", key: "next-action" },
      ],
    },
    {
      source: "/pay/:id",
      missing: [
        { type: "header", key: "rsc" },
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "next-router-state-tree" },
        { type: "header", key: "next-action" },
      ],
    },
  ],
};
