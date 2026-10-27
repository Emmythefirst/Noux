// Amounts arrive as base-unit strings. 6 decimals: "100000" = "0.100000" USDC. Never use floats for money.
export function fmtAmount(base: string | bigint, decimals = 6): string {
  let s = (typeof base === "bigint" ? base : BigInt(base)).toString();
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  while (s.length <= decimals) s = "0" + s;
  const out = s.slice(0, s.length - decimals) + "." + s.slice(s.length - decimals);
  return neg ? "-" + out : out;
}

/** 2-decimal display for headline numbers ("49.790000" -> "49.79"). Truncates, never rounds up. */
export function fmt2(base: string | bigint, decimals = 6): string {
  return fmtAmount(base, decimals).replace(/^(-?\d+\.\d{2})\d*$/, "$1");
}

/** Up to 3 significant fractional digits, trimmed ("0.014000" -> "0.014"), for small totals. */
export function fmtShort(base: string | bigint, decimals = 6): string {
  const v = fmtAmount(base, decimals);
  const [i, f] = v.split(".");
  const t = f.replace(/0+$/, "");
  return t.length === 0 ? `${i}.00` : t.length === 1 ? `${i}.${t}0` : `${i}.${t.slice(0, 3)}`;
}

/** Middle-truncated: 7xKX…q9Fp */
export function short(a: string, head = 4, tail = 4): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** basis points -> "15.00%" */
export function bpsPct(bps: number, digits = 2): string {
  return (bps / 100).toFixed(digits) + "%";
}

export function pctOf(part: string | bigint, whole: string | bigint): number {
  const w = BigInt(whole);
  return w === 0n ? 0 : Number((BigInt(part) * 10000n) / w) / 100;
}

export function initials(name: string): string {
  const w = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return "?";
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
}

export const CATEGORIES: Record<string, string> = {
  "ai-text": "AI and text",
  "research-search": "Research and search",
  "data-feeds": "Data feeds",
  "developer-tools": "Developer tools",
  other: "Other",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** "Oct 27, 09:41" (UTC) */
export function dayTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
/** "Oct 27, 2026, 09:39:05 UTC" */
export function fullUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}
export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dayTime(iso);
}

/** seconds -> "1:12" */
export function mmss(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
}
