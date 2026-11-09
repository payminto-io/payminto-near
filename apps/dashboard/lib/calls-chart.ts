const BUCKETS = [5, 10, 30, 60, 300, 900, 3600].map((s) => s * 1000);
const MAX_BARS = 30;
/** A steady frame: at least this many bars, so the first calls land on an axis that does not jump. */
const MIN_BARS = 24;

/**
 * Bars sized to the traffic: a demo that ran for a minute shows calls per 5 seconds, a node that has run all day shows
 * calls per hour over the last 12 hours. The window starts one bucket before the oldest loaded call and ends at most a
 * minute after the newest one.
 */
export function bucketCalls(items: { createdAt: string; amount: string }[], nowMs: number) {
  const times = items.map((c) => new Date(c.createdAt).getTime());
  const first = times.length ? Math.min(...times) : nowMs;
  // Once traffic stops, keep the burst framed (up to a minute of quiet after it) instead of squeezing it to the left.
  if (times.length) nowMs = Math.min(nowMs, Math.max(...times) + 60_000);
  const span = Math.max(0, nowMs - first);
  const size = BUCKETS.find((b) => span / b <= MAX_BARS - 2) ?? 3_600_000;
  const hourly = size === 3_600_000;
  const end = Math.floor(nowMs / size) * size;
  const start = hourly ? end - 11 * size : Math.min(Math.floor(first / size) * size - size, end - (MIN_BARS - 1) * size);
  const n = Math.max(2, Math.round((end - start) / size) + 1);
  const fmt: Intl.DateTimeFormatOptions = size < 60_000 ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
  const bars = Array.from({ length: n }, (_, i) => {
    const t = start + i * size;
    return { t, label: new Date(t).toLocaleTimeString("en-GB", fmt), calls: 0, volume: 0n };
  });
  items.forEach((c, i) => {
    const idx = Math.floor((times[i]! - start) / size);
    if (idx >= 0 && idx < bars.length) {
      bars[idx]!.calls += 1;
      bars[idx]!.volume += BigInt(c.amount);
    }
  });
  const unit = size < 60_000 ? `${size / 1000} seconds` : size === 60_000 ? "minute" : size < 3_600_000 ? `${size / 60_000} minutes` : "hour";
  return { bars: bars.map((b) => ({ ...b, volume: b.volume.toString() })), unit, hourly };
}
