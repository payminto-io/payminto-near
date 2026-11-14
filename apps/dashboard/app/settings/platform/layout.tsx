import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Platform settings - Payminto" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
