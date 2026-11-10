"use client";

import { RequirePermission } from "@/components/app/states";
import { WebhooksList } from "@/components/gateway/webhooks-list";

export default function PlatformWebhooksPage() {
  return (
    <RequirePermission permission={"agents.read"}>
      <WebhooksList scope="platform" />
    </RequirePermission>
  );
}
