import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Verify - Payminto" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
