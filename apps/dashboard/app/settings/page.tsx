"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAccess } from "@/lib/session";
import { PageHeader } from "@/components/app/primitives";
import { BlockSkeleton } from "@/components/app/states";
import { BusinessProfile } from "@/components/gateway/merchant-settings";

/** Settings > Business > Profile; on the platform view Settings opens on Platform > General. */
export default function SettingsPage() {
  const access = useAccess();
  const router = useRouter();
  const business = access.view?.kind === "business";
  useEffect(() => {
    if (!business) router.replace(access.can("platform.read") ? "/settings/platform" : "/account");
  }, [business, access, router]);
  if (!business) return <BlockSkeleton className="h-80" />;
  return (
    <>
      <PageHeader title="Business profile" description="Name, logo, brand color and support email, as customers see them." />
      <BusinessProfile />
    </>
  );
}
