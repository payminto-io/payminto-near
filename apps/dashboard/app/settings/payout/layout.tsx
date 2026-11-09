import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Payout wallet - Payminto" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
