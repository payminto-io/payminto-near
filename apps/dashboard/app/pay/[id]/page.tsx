"use client";

import { useParams } from "next/navigation";
import { CheckoutScreen } from "@/components/checkout/checkout";

export default function PayPage() {
  const { id } = useParams<{ id: string }>();
  return <CheckoutScreen id={id} />;
}
