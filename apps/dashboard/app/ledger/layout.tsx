import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Balances - Payminto" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
