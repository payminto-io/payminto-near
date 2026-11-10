"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { layoutFlow, type FlowLink, type FlowNode, type Obligation } from "@/lib/netting";
import { formatInt, formatMoney, shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";

const FLOW_COLORS = ["var(--flow-1)", "var(--flow-2)", "var(--flow-3)", "var(--flow-4)", "var(--flow-5)"];

type Props = {
  obligations: readonly Obligation[];
  nameOf: (address: string) => string | null;
  symbol: string;
  decimals: number;
  /** Fades the ribbons out, used while the batch settles so the eye moves to the net side. */
  collapsed?: boolean;
  className?: string;
};

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Gross obligations between payers (left) and payees (right) as a two-column Sankey.
 * A wallet that both buys and sells (Research Writer) appears on both sides with a dashed node, which is
 * exactly the obligation pair that netting cancels.
 */
export function FlowGraph({ obligations, nameOf, symbol, decimals, collapsed, className }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<string | null>(null);
  const titleId = useId();

  const label = Math.min(156, Math.max(96, Math.round(width * 0.27)));
  const inner = Math.max(120, width - label * 2);
  const layout = useMemo(() => layoutFlow(obligations, { width: inner, nodeWidth: 8, gap: 22 }), [obligations, inner]);

  const payerColor = useMemo(() => {
    const m = new Map<string, string>();
    layout.nodes.filter((n) => n.side === "payer").forEach((n, i) => m.set(n.address, FLOW_COLORS[i % FLOW_COLORS.length]!));
    return m;
  }, [layout]);

  const activeLink = layout.links.find((l) => l.id === active) ?? null;
  const activeNode = active?.startsWith("payer:") || active?.startsWith("payee:") ? active : null;
  const isLit = (l: FlowLink) => {
    if (!active) return true;
    if (activeNode) return activeNode === `payer:${l.from}` || activeNode === `payee:${l.to}`;
    return l.id === active;
  };
  const litNodes = new Set<string>();
  if (active) {
    for (const l of layout.links) {
      if (isLit(l)) {
        litNodes.add(`payer:${l.from}`);
        litNodes.add(`payee:${l.to}`);
      }
    }
  }
  const name = (a: string) => nameOf(a) ?? shortAddress(a);
  const money = (v: bigint) => `${formatMoney(v, decimals)} ${symbol}`;

  const caption = activeLink
    ? `${name(activeLink.from)} owes ${name(activeLink.to)} ${money(activeLink.amount)} across ${formatInt(activeLink.calls)} calls`
    : activeNode
      ? (() => {
          const n = layout.nodes.find((x) => x.id === activeNode)!;
          return `${name(n.address)} ${n.side === "payer" ? "owes" : "is owed"} ${money(n.total)} gross`;
        })()
      : "Hover or focus a ribbon to read who owes whom.";

  return (
    <figure className={cn("min-w-0", className)} aria-labelledby={titleId}>
      <div className="mb-3 flex items-baseline justify-between text-xs text-muted-foreground">
        <span>Payers</span>
        <span>Payees</span>
      </div>
      <div ref={ref} className="w-full">
        {width > 0 && (
          <svg
            width={width}
            height={layout.height}
            viewBox={`0 0 ${width} ${layout.height}`}
            role="group"
            aria-label="Who owes whom before bundling"
            className="block overflow-visible"
          >
            <g transform={`translate(${label},0)`}>
              {layout.links.map((l) => (
                <path
                  key={l.id}
                  d={l.path}
                  tabIndex={0}
                  role="img"
                  aria-label={`${name(l.from)} to ${name(l.to)}: ${money(l.amount)}, ${l.calls} calls`}
                  fill={payerColor.get(l.from)}
                  className="cursor-pointer outline-none transition-[opacity,fill-opacity] duration-500 focus-visible:[fill-opacity:0.7]"
                  style={{
                    fillOpacity: active ? (isLit(l) ? 0.62 : 0.08) : 0.3,
                    opacity: collapsed ? 0.12 : 1,
                  }}
                  onMouseEnter={() => setActive(l.id)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(l.id)}
                  onBlur={() => setActive(null)}
                />
              ))}
              {layout.nodes.map((n) => (
                <NodeMark
                  key={n.id}
                  node={n}
                  nodeWidth={layout.nodeWidth}
                  color={n.side === "payer" ? payerColor.get(n.address)! : "var(--flow-node)"}
                  labelWidth={label}
                  title={name(n.address)}
                  amount={money(n.total)}
                  dim={Boolean(active) && !litNodes.has(n.id)}
                  onEnter={() => setActive(n.id)}
                  onLeave={() => setActive(null)}
                />
              ))}
            </g>
          </svg>
        )}
        {width === 0 && <div style={{ height: layout.height }} />}
      </div>
      <figcaption id={titleId} className="mt-3 min-h-5 text-[0.8125rem] text-muted-foreground" aria-live="polite">
        {caption}
      </figcaption>
    </figure>
  );
}

function NodeMark({
  node,
  nodeWidth,
  color,
  labelWidth,
  title,
  amount,
  dim,
  onEnter,
  onLeave,
}: {
  node: FlowNode;
  nodeWidth: number;
  color: string;
  labelWidth: number;
  title: string;
  amount: string;
  dim: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const left = node.side === "payer";
  const tx = left ? node.x - 10 : node.x + nodeWidth + 10;
  const cy = node.y + node.height / 2;
  const lines = wrapLabel(title, Math.floor((labelWidth - 14) / 7));
  const top = cy - 3 - (lines.length - 1) * 7;
  return (
    <g
      className="transition-opacity duration-300"
      style={{ opacity: dim ? 0.45 : 1 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {node.dual && (
        <rect
          x={node.x - 3}
          y={node.y - 3}
          width={nodeWidth + 6}
          height={node.height + 6}
          rx={4}
          fill="none"
          stroke="var(--subtle)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      <rect x={node.x} y={node.y} width={nodeWidth} height={node.height} rx={2} fill={color} />
      <text x={tx} y={top} textAnchor={left ? "end" : "start"} className="fill-foreground text-[12.5px] font-medium">
        <title>{title}</title>
        {lines.map((l, i) => (
          <tspan key={i} x={tx} dy={i === 0 ? 0 : 14}>
            {l}
          </tspan>
        ))}
      </text>
      <text x={tx} y={top + (lines.length - 1) * 14 + 15} textAnchor={left ? "end" : "start"} className="num fill-muted-foreground text-[11.5px]">
        {amount}
      </text>
      {node.dual && (
        <text x={tx} y={top + (lines.length - 1) * 14 + 29} textAnchor={left ? "end" : "start"} className="fill-subtle text-[10.5px]">
          {left ? "also a payee" : "also a payer"}
        </text>
      )}
    </g>
  );
}

/** Breaks a label into at most two lines on word boundaries, truncating only what still does not fit. */
export function wrapLabel(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  lines.push(cur);
  const out = lines.slice(0, 2);
  if (lines.length > 2) out[1] = `${out[1]} ${lines.slice(2).join(" ")}`;
  return out.map((l) => (l.length > maxChars ? `${l.slice(0, Math.max(3, maxChars - 1))}…` : l));
}
