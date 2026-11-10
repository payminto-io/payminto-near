"use client";

import { RequirePermission } from "@/components/app/states";
import { WebhookDetail } from "@/components/gateway/webhook-detail";

export default function PlatformWebhookDetailPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <WebhookDetail scope="platform" />
    </RequirePermission>
  );
}
