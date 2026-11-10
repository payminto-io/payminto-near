"use client";

import { ExternalLink } from "lucide-react";
import type { PaymentLink } from "@/lib/schemas";
import { embedSnippet } from "@/lib/embed";
import { CopyAction } from "@/components/checkout/parts";
import { CodeBlock } from "./kit";

/**
 * The drop-in for one payment link: the two lines to paste into a site, with this link's slug filled in. The button
 * opens the hosted checkout in a popup (public/embed.js); the plain link keeps working with no code.
 */
export function EmbedSnippet({ link, compact = false }: { link: Pick<PaymentLink, "url" | "slug">; compact?: boolean }) {
  const s = embedSnippet(link.url, link.slug);
  return (
    <div className="flex flex-col gap-3">
      {!compact && <p className="text-sm text-muted-foreground">Paste these two lines into your site. The button opens this checkout in a small window; on a phone it opens in the same tab.</p>}
      <CodeBlock code={s.all} label="Embed code" copy={<CopyAction value={s.all} label="Copy" className="h-7 px-2 text-xs" />} />
      <p className="text-xs text-muted-foreground">
        When the payment is made, the button receives a <code className="hash text-[0.75rem]">payminto:paid</code> event. Use it to update your page, and fulfil orders from the signed webhook.
      </p>
      {!compact && (
        <a href={`${s.origin}/embed-demo.html?link=${encodeURIComponent(link.slug)}`} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground">
          Try it on a demo page <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </div>
  );
}
