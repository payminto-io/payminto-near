"use client";

import { PageHeader } from "@/components/app/primitives";
import { PayoutSettings } from "@/components/gateway/merchant-settings";

export default function Page() {
  return (
    <>
      <PageHeader title="Payout wallet" description="Where your money arrives." />
      <PayoutSettings />
    </>
  );
}
