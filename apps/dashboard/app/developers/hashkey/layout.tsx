import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "HashKey Chain - Payminto" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
