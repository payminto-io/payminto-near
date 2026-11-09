"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { easeOut, interpolate, numberTokens } from "@/lib/count-up";

const DURATION = 500;

function reduced(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/**
 * Wraps a stat value; the numbers in its text count up from the previous value. Screen readers get the final text at
 * once (the animation only rewrites visible text nodes) and reduced motion skips it.
 */
export function CountUp({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef<Map<number, number[]>>(new Map());
  useLayoutEffect(() => {
    const el = ref.current;
    // A hidden tab never runs animation frames, so it would keep showing the starting zeros: no animation there.
    if (!el || reduced() || document.hidden) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; target: string; from: number[] }[] = [];
    let i = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode(), i++) {
      const node = n as Text;
      const target = node.data;
      const tokens = numberTokens(target);
      if (!tokens.length) continue;
      const prev = last.current.get(i) ?? tokens.map(() => 0);
      last.current.set(i, tokens.map((t) => t.value));
      if (prev.every((v, k) => v === tokens[k]?.value)) continue;
      nodes.push({ node, target, from: prev });
    }
    if (!nodes.length) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = easeOut((now - t0) / DURATION);
      for (const x of nodes) x.node.data = interpolate(x.target, x.from, p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    for (const x of nodes) x.node.data = interpolate(x.target, x.from, 0);
    raf = requestAnimationFrame(tick);
    // Frames can stop mid-way (the tab is hidden); the real value is always written in the end.
    const done = window.setTimeout(() => {
      cancelAnimationFrame(raf);
      for (const x of nodes) x.node.data = x.target;
    }, DURATION + 100);
    return () => {
      window.clearTimeout(done);
      cancelAnimationFrame(raf);
      for (const x of nodes) x.node.data = x.target;
    };
  });
  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}
