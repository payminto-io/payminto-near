import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "New payment link - Payminto" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
