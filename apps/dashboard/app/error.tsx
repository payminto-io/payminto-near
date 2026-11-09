"use client";

import { ErrorState } from "@/components/app/states";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="py-10">
      <ErrorState error={error} onRetry={reset} />
    </div>
  );
}
