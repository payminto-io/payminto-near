import type { Metadata } from "next";
import { SettingsFrame } from "@/components/gateway/settings-frame";

export const metadata: Metadata = { title: { absolute: "Settings - Payminto" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <SettingsFrame>{children}</SettingsFrame>;
}
