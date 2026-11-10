"use client";

import { useRef, useState } from "react";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { Download, ExternalLink } from "lucide-react";
import type { PaymentLink } from "@/lib/schemas";
import { embedButtonHtml } from "@/lib/gateway";
import { useMerchant } from "@/lib/gateway-queries";
import { useInfo } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CopyAction } from "@/components/checkout/parts";
import { CodeBlock, Segmented } from "./kit";

/** What the samples name: the server the agent trusts and the hub it clears on, from `/v1/info`, and the link's price. */
export type AgentSnippetContext = { network?: string | null; hub?: string | null; nodeUrl?: string | null; amount?: string | null };

const OPEN_AMOUNT_EXAMPLE = "5000000";

/** An atomic amount as a TypeScript bigint literal: 5000000 becomes 5_000_000n. */
const bigintLiteral = (atomic: string) => `${atomic.replace(/\B(?=(\d{3})+$)/g, "_")}n`;

/**
 * The agent side of one link (GATEWAY.md section 5): a plain request answers 402 with a PAYMENT-REQUIRED header, x402
 * version 2, whose one offer is a `payminto-voucher` on NEAR. An agent pays it with `AgentClient` from `@payminto/sdk`
 * (packages/sdk/README.md, "Gateway client"): a voucher signed by its Budget key, never a token transfer of its own.
 */
export function agentSnippets(url: string, openAmount: boolean, ctx: AgentSnippetContext = {}) {
  const target = openAmount ? `${url}?amount=${OPEN_AMOUNT_EXAMPLE}` : url;
  const maxPrice = bigintLiteral(openAmount ? OPEN_AMOUNT_EXAMPLE : (ctx.amount ?? OPEN_AMOUNT_EXAMPLE));
  const network = ctx.network ?? "near:testnet";
  const hub = ctx.hub ?? "<hub account>";
  const nodeUrl = ctx.nodeUrl ?? "<your Payminto server>";
  return {
    curl: [
      "# Ask like an agent: no text/html in Accept, so the server answers 402",
      `curl -i -H "Accept: application/json" "${target}"`,
      "",
      "# HTTP/1.1 402 Payment Required",
      `# PAYMENT-REQUIRED: <base64 JSON, x402 version 2: one payminto-voucher offer on ${network}>`,
      "",
      "# Retry with a voucher signed by the agent's Budget key; the server clears it and answers 200",
      `curl -i -H "Accept: application/json" -H "PAYMENT-SIGNATURE: <base64 payload>" "${target}"`,
      "# PAYMENT-RESPONSE: <base64 JSON: success, network, payer, receipts, positions>",
      "# Body: payment_id, status, amount_due, amount_paid",
    ].join("\n"),
    sdk: [
      'import { AgentClient, defaultAgentKeyPath, readAgentKeyFile } from "@payminto/sdk";',
      "",
      "// The agent holds a bare ed25519 key: no NEAR account and no gas. It signs vouchers within its Budget.",
      "const agent = new AgentClient({",
      `  network: "${network}",`,
      `  hub: "${hub}",`,
      `  nodeUrl: "${nodeUrl}",`,
      '  budgetId: "<Budget id>",',
      "  keypair: readAgentKeyFile(defaultAgentKeyPath()),",
      "});",
      "",
      "// Answers the 402 with a signed voucher and retries. A price above maxPrice is refused without signing.",
      `const { response, payment } = await agent.pay("${target}", { headers: { accept: "application/json" } }, { maxPrice: ${maxPrice} });`,
      'console.log(payment.status, payment.paid); // "paid" once the agent\'s own server booked the voucher',
      "console.log((await response.json()).payment_id);",
    ].join("\n"),
    mcp: `// An agent with a Payminto Budget pays the link with signed vouchers, checked against its limits:\npay_link({ url: "${url}"${openAmount ? `, amountAtomic: "${OPEN_AMOUNT_EXAMPLE}"` : ""} })`,
  };
}

export function ShareSheet({ link, open, onOpenChange }: { link: PaymentLink; open: boolean; onOpenChange: (o: boolean) => void }) {
  const url = link.url;
  const [tab, setTab] = useState<"link" | "agents" | "embed">("link");
  const svgRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const info = useInfo();
  const snippets = agentSnippets(url, link.amount === null, { network: info.data?.network.id, hub: info.data?.hub, nodeUrl: info.data?.publicUrl, amount: link.amount });
  const file = `payminto-${link.slug}`;
  const merchant = useMerchant(link.merchant_id);
  const button = embedButtonHtml(url, merchant.data?.brand_color);

  const download = (href: string, name: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-[28rem]">
        <SheetHeader className="border-b">
          <SheetTitle>Share &ldquo;{link.title}&rdquo;</SheetTitle>
          <SheetDescription>One link for people and AI agents. A person gets the checkout page; an agent pays automatically.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 p-4">
          <Segmented
            label="Share as"
            value={tab}
            onChange={setTab}
            className="w-full"
            options={[
              { key: "link", label: "Link and QR" },
              { key: "agents", label: "AI agents" },
              { key: "embed", label: "Embed" },
            ]}
          />
          {tab === "link" && (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="share-url" className="text-sm font-medium">
                  Payment link
                </label>
                <div className="flex gap-2">
                  <Input id="share-url" readOnly value={url} className="hash text-[0.8125rem]" onFocus={(e) => e.currentTarget.select()} />
                  <CopyAction value={url} label="Copy link" className="shrink-0" />
                </div>
                <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground">
                  Open the checkout page <ExternalLink className="size-3" aria-hidden />
                </a>
              </div>
              <div className="flex flex-col items-center gap-3 rounded-xl border p-5">
                <div ref={svgRef} className="rounded-lg bg-white p-3">
                  <QRCodeSVG value={url} size={176} level="M" marginSize={0} title={`QR code for ${url}`} />
                </div>
                <div ref={canvasRef} className="hidden" aria-hidden>
                  <QRCodeCanvas value={url} size={1024} level="M" marginSize={4} />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const c = canvasRef.current?.querySelector("canvas");
                      if (c) download(c.toDataURL("image/png"), `${file}.png`);
                    }}
                  >
                    <Download /> Download PNG
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const svg = svgRef.current?.querySelector("svg");
                      if (!svg) return;
                      const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
                      const href = URL.createObjectURL(blob);
                      download(href, `${file}.svg`);
                      setTimeout(() => URL.revokeObjectURL(href), 1000);
                    }}
                  >
                    <Download /> Download SVG
                  </Button>
                </div>
              </div>
            </>
          )}
          {tab === "agents" && (
            <>
              <p className="text-sm text-muted-foreground">The same link is payable by software. {link.amount === null ? "This link lets the customer choose the amount, so agents add ?amount= in base units." : ""}</p>
              {(
                [
                  ["HTTP (curl)", snippets.curl],
                  ["AI agent with a Budget (SDK)", snippets.sdk],
                  ["AI agent with a Budget (MCP)", snippets.mcp],
                ] as const
              ).map(([label, code]) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <p className="text-sm font-medium">{label}</p>
                  <CodeBlock code={code} label={label} copy={<CopyAction value={code} label="Copy" className="h-7 px-2 text-xs" />} />
                </div>
              ))}
            </>
          )}
          {tab === "embed" && (
            <>
              <div className="flex flex-col items-center gap-2 rounded-xl border bg-muted/30 p-5">
                <span
                  aria-hidden
                  style={{ display: "inline-block", padding: "10px 16px", borderRadius: 8, background: button.background, color: button.color, font: "600 15px system-ui" }}
                >
                  Pay with crypto
                </span>
                <p className="text-xs text-muted-foreground">{merchant.data?.brand_color ? "In your brand color" : "Set a brand color in Settings to match your site"}</p>
              </div>
              {(
                [
                  ["Button", button.html],
                  ["Inline frame", `<iframe src="${url}" title="${link.title.replace(/"/g, "&quot;")}" width="100%" height="720" style="border:0"></iframe>`],
                ] as const
              ).map(([label, code]) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <p className="text-sm font-medium">{label}</p>
                  <CodeBlock code={code} label={label} copy={<CopyAction value={code} label="Copy" className="h-7 px-2 text-xs" />} />
                </div>
              ))}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
