/**
 * The only colours charts may use. Each is a CSS custom property declared for both themes in app/globals.css,
 * which test/chart-theme.test.ts enforces, so a chart can never fall back to transparent in one theme.
 */
export const CHART_TOKENS = {
  bar: "--chart-bar",
  line: "--chart-line",
  grid: "--chart-grid",
  axis: "--chart-axis",
  cursor: "--chart-cursor",
} as const;

export type ChartToken = keyof typeof CHART_TOKENS;

export const chartColor = (t: ChartToken) => `var(${CHART_TOKENS[t]})`;

/** Shared Recharts axis tick style. */
export const axisTick = { fill: chartColor("axis"), fontSize: 11 } as const;
