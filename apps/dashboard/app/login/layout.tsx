import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "Sign in - Payminto" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
