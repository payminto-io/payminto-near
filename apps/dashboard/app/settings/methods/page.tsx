"use client";

import { RequirePermission } from "@/components/app/states";
import { PageHeader } from "@/components/app/primitives";
import { MethodsSettings } from "@/components/gateway/merchant-settings";

function PagePage() {
  return (
    <>
      <PageHeader title="Payment methods" description="The ways customers and agents can pay you." />
      <MethodsSettings />
    </>
  );
}

export default function Page() {
  return (
    <RequirePermission permission={"business.update"}>
      <PagePage />
    </RequirePermission>
  );
}
