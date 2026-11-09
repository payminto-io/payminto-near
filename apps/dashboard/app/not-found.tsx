import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: { absolute: "Not found - Payminto" } };

export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-3 py-16">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-[-0.015em]">This page does not exist</h1>
      <p className="max-w-[52ch] text-muted-foreground">The link may point to a payment, budget or settlement this Payminto server does not know about.</p>
      <Link href="/" className="mt-2 text-sm font-medium text-primary hover:underline">
        Go to Home
      </Link>
    </div>
  );
}
