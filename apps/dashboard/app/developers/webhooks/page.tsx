"use client";

import { RequirePermission } from "@/components/app/states";
import { WebhooksList } from "@/components/gateway/webhooks-list";

export default function WebhooksPage() {
  return (
    <RequirePermission permission={"developers.manage"}>
      <WebhooksList scope="business" />
    </RequirePermission>
  );
}
