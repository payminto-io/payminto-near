"use client";

import { useRef } from "react";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function download(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
}

/**
 * A payment link as a QR code to print or put on a counter, with a PNG (1024 px, with its quiet zone) and an SVG to
 * download. `file` names the downloads without an extension.
 */
export function LinkQr({ url, file, className }: { url: string; file: string; className?: string }) {
  const svgRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div ref={svgRef} className="rounded-lg border bg-white p-3">
        <QRCodeSVG value={url} size={176} level="M" marginSize={0} title={`QR code of ${url}`} className="block size-44" />
      </div>
      <div ref={canvasRef} className="hidden" aria-hidden>
        <QRCodeCanvas value={url} size={1024} level="M" marginSize={4} />
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-11 md:h-8"
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
          className="h-11 md:h-8"
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
  );
}
