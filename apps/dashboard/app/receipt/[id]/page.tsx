"use client";

import { useParams } from "next/navigation";
import { ReceiptScreen } from "@/components/checkout/receipt-screen";

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  return <ReceiptScreen id={id} />;
}
