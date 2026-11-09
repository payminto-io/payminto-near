"use client";

import { useParams } from "next/navigation";
import { LinkScreen } from "@/components/checkout/link-screen";

export default function LinkPage() {
  const { slug } = useParams<{ slug: string }>();
  return <LinkScreen slug={slug} />;
}
