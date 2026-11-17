// Number display for stat widgets. en-US on purpose: the output is the same on every machine.

export const FORMAT_RE = /^(auto|integer|compact|percent|duration|currency:[A-Z]{3})$/;

const group = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const decimals = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

function duration(sec: number): string {
  const neg = sec < 0;
  let s = Math.abs(sec);
  if (s < 60) return `${neg ? "-" : ""}${Number(s.toFixed(s < 10 ? 1 : 0))}s`;
  s = Math.round(s);
  const parts: string[] = [];
  for (const [n, u] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]] as const) {
    if (s >= n) {
      parts.push(`${Math.floor(s / n)}${u}`);
      s %= n;
    }
    if (parts.length === 2) break;
  }
  return (neg ? "-" : "") + parts.join(" ");
}

/** `percent` takes a ratio (0.42 shows 42%); `duration` takes seconds; `auto` groups integers and shortens big numbers. */
export function formatValue(value: unknown, format = "auto", unit = ""): string {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return String(value ?? "").slice(0, 40);
  let text: string;
  if (format === "integer") text = group.format(n);
  else if (format === "compact") text = compact.format(n);
  else if (format === "percent") text = percent.format(n);
  else if (format === "duration") text = duration(n);
  else if (format.startsWith("currency:")) {
    try {
      text = new Intl.NumberFormat("en-US", { style: "currency", currency: format.slice(9), maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
    } catch {
      text = decimals.format(n);
    }
  } else text = Math.abs(n) >= 10_000 ? compact.format(n) : decimals.format(n);
  return unit ? text + (unit === "%" ? "" : " ") + unit : text;
}

/** The change from `prev` to `cur`, signed, as a ratio when prev is not zero. */
export function deltaOf(cur: number, prev: number, format = "auto"): { value: number; pct?: number; display: string } | undefined {
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return undefined;
  const value = cur - prev;
  const pct = prev !== 0 ? value / Math.abs(prev) : undefined;
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const display =
    pct !== undefined
      ? `${sign}${Math.abs(pct * 100).toFixed(Math.abs(pct) < 0.1 ? 1 : 0)}%`
      : `${sign}${formatValue(Math.abs(value), format === "percent" ? "auto" : format)}`;
  return { value, pct, display };
}
