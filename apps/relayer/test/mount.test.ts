import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HUB, OWNER, RELAYER, bodyOf, errorOf, harness, revoke } from "./helpers.ts";

describe("createRelayerApp mounted inside another Hono app", () => {
  const mounted = () => {
    const h = harness({ trustProxyHops: 1, maxBodyBytes: 1_024, rateLimit: { ip: { perMin: 6, burst: 3 }, sender: { perMin: 0, burst: 1 } } });
    const parent = new Hono();
    parent.get("/", (c) => c.text("the host app"));
    parent.route("/relayer", h.app);
    const post = (body: string, ip = "203.0.113.9") => parent.request("/relayer/relay", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body });
    return { h, parent, post };
  };

  it("serves the same routes under the mount path and leaves the host's own routes alone", async () => {
    const { h, parent, post } = mounted();
    expect(await (await parent.request("/")).text()).toBe("the host app");
    expect(await (await parent.request("/relayer/info")).json()).toMatchObject({ relayer: RELAYER, hub: HUB });
    expect(((await (await parent.request("/relayer/health")).json()) as { ok: boolean }).ok).toBe(true);
    const res = await post(JSON.stringify(bodyOf(revoke())));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sender: OWNER, receiver: HUB, methods: ["revoke_budget"] });
    expect(h.chain.submissions).toHaveLength(1);
  });

  it("keeps its own error shape, body cap and rate limit when mounted", async () => {
    const { post } = mounted();
    const refusedRes = await post(JSON.stringify(bodyOf(revoke({ receiverId: "other.testnet" }))));
    expect(refusedRes.status).toBe(403);
    expect((await errorOf(refusedRes)).code).toBe("NOT_SPONSORED");

    // An oversized body is refused, and it still counts against the address that sent it.
    const big = await post(JSON.stringify({ signedDelegate: "A".repeat(4_000) }));
    expect(big.status).toBe(413);
    expect((await post("{}")).status).toBe(400);
    const limited = await post("{}");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("10");
    expect((await errorOf(limited)).code).toBe("RATE_LIMITED");
    // Reads are not limited.
    expect((await (await mounted().parent.request("/relayer/info")).json()) as object).toBeTruthy();
  });
});
