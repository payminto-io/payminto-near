"use client";

import { RequirePermission } from "@/components/app/states";
import { WebhookDetail } from "@/components/gateway/webhook-detail";

export default function WebhookDetailPage() {
  return (
    <RequirePermission permission={"developers.manage"}>
      <WebhookDetail scope="business" />
    </RequirePermission>
  );
}
