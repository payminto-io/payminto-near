import { resolve } from "node:path";
import type { NextConfig } from "next";
import { REDIRECTS } from "./lib/routes";

// The Docker image builds with NEXT_OUTPUT=standalone; tracing starts at the monorepo root so workspace packages are included.
const standalone = process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const, outputFileTracingRoot: resolve(process.cwd(), "../..") } : {};

const nextConfig: NextConfig = {
  ...standalone,
  transpilePackages: ["@payminto/protocol", "@payminto/chain", "@payminto/near-addons", "@payminto/payee-check"],
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  // Old URLs keep working (PRODUCT.md section 2.4).
  async redirects() {
    return REDIRECTS;
  },
};

export default nextConfig;
