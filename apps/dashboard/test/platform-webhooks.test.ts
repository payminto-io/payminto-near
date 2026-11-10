import { describe, expect, it } from "vitest";
import { MockClearingApi } from "@/lib/mock/server";
import { refusalDenialOf } from "@/components/gateway/webhook-parts";
import { isHubUnreadable, refusalOf } from "@/lib/denials";

describe("platform refusal alerts", { timeout: 20_000 }, () => {
  const api = new MockClearingApi();

  it("keeps the platform's endpoints apart from a business's", async () => {
    const platform = await api.platformWebhooks.webhooks();
    const business = await api.gateway.webhooks();
    expect(platform.map((e) => e.events)).toEqual([["budget.refused"]]);
    expect(business.some((e) => platform.some((p) => p.id === e.id))).toBe(false);
    await expect(api.gateway.webhook(platform[0]!.id)).rejects.toMatchObject({ code: "WEBHOOK_NOT_FOUND" });
  });

  it("delivers one budget.refused per refusal, which reads back as the Refusal with its retry hint", async () => {
    const [ops] = await api.platformWebhooks.webhooks();
    const page = await api.platformWebhooks.deliveries(ops!.id);
    const denials = await api.denials();
    expect(page.items).toHaveLength(denials.length);
    expect(page.items.every((d) => d.event_type === "budget.refused")).toBe(true);
    const exposure = page.items.map((d) => refusalDenialOf(d.request_body ?? "")).filter((d) => d?.rule === "NET_EXPOSURE");
    // An escrow shortfall, with the owner action that covers it from hub credit.
    const net = exposure.find((d) => refusalOf(d!).retry.kind === "fund");
    expect(net).toBeTruthy();
    const r = refusalOf(net!);
    expect(r.retry.kind === "fund" && r.retry.fromCredit?.action).toBe("fund_from_credit");
    // A hub the server could not read carries the same rule and says so in the hint, which survives the webhook.
    const unread = exposure.find((d) => isHubUnreadable(refusalOf(d!).retry));
    expect(unread).toBeTruthy();
    expect(refusalOf(unread!).retry).toEqual({ kind: "after", seconds: 5, reason: "hub_unreadable" });
  });

  it("ignores a body that is not a refusal", () => {
    expect(refusalDenialOf('{"type":"ping","data":{"object":{"message":"hi"}}}')).toBeNull();
    expect(refusalDenialOf("not json")).toBeNull();
  });
});
