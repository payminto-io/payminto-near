"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Renders children at a fixed design width and scales them down to fit the container, so a desktop preview keeps
 * its real two-column layout inside a narrower panel (Stripe's payment link preview).
 */
export function ScaledFrame({ width, children, className }: { width: number; children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const s = Math.min(1, o.clientWidth / width);
      setScale(s);
      setHeight(i.offsetHeight * s);
    };
    const ro = new ResizeObserver(update);
    ro.observe(o);
    ro.observe(i);
    update();
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={outer} className={className} style={{ height }}>
      <div ref={inner} style={{ width, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}
