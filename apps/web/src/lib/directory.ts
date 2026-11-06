// Pure helpers for the campaign directory: what a distributor earns, how long a budget lasts, what to show for refunds, and the list's filters and sorts.
// Money is bigint base units throughout; nothing here guesses a number it cannot read.
import type { Campaign } from "./api";
import { CATEGORIES } from "./format";

/** Base units of ONE listed price ("$0.10", "0.10 USDC", "$0.10 / call"); null for a range ("$0.03-$0.10"), free text, or more digits than the token has. */
export function singlePrice(displayPrice: string | null | undefined, decimals = 6): bigint | null {
  const m = displayPrice ? /^\$?\s*(\d+)(?:\.(\d+))?\s*(?:USDC)?(?:\s*\/.*)?$/i.exec(displayPrice.trim()) : null;
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  const units = BigInt(m[1] + frac.padEnd(decimals, "0"));
  return units > 0n ? units : null;
}

/** The split of one sale exactly as the program computes it: fee and commission floored, commission limited by the budget left, merchant keeps the rest. */
export function splitOf(units: bigint, commissionBps: number, feeBps: number, budgetRemaining: bigint) {
  const fee = (units * BigInt(feeBps)) / 10000n;
  const owed = (units * BigInt(commissionBps)) / 10000n;
  const commission = owed < budgetRemaining ? owed : budgetRemaining;
  return { merchant: units - fee - commission, commission, fee };
}

/** What a distributor earns per sale at the listed price (before the budget cap); null when the price is a range or unreadable. */
export function earnPerSale(c: Pick<Campaign, "commissionBps" | "listing" | "decimals">): bigint | null {
  const u = singlePrice(c.listing?.displayPrice, c.decimals);
  return u === null ? null : (u * BigInt(c.commissionBps)) / 10000n;
}

/** How many sales the remaining commission budget covers (floor); null when it cannot be known, 0 when the budget is spent. */
export function runwaySales(c: Pick<Campaign, "commissionBps" | "listing" | "decimals" | "budget">): number | null {
  const per = earnPerSale(c);
  if (per === null || per === 0n) return null;
  const left = BigInt(c.budget.remaining);
  return Number(left / per);
}

/** A campaign that can take a referral sale right now: not paused or ended, and budget left. */
export const isOpen = (c: Pick<Campaign, "state" | "status">): boolean => (c.state ?? "active") === "active" && c.status === "active";

export function directoryTotals(items: Campaign[]) {
  let open = 0, budget = 0n;
  for (const c of items) if (isOpen(c)) { open++; budget += BigInt(c.budget.remaining); }
  return { listed: items.length, open, budgetAvailable: budget };
}

/** Refund cell text: a rate once there is a settled sale; plain counts before that (a 100% rate next to 0 sales reads like a bug). */
export function refundText(c: Pick<Campaign, "sales">): string {
  const { settled, refunded, refundRate } = c.sales;
  if (settled === 0) return refunded > 0 ? `${refunded} refunded` : "—";
  return refundRate === null ? "—" : `${(refundRate * 100).toFixed(refundRate === 0 ? 0 : 1)}%`;
}

export type Sort = "newest" | "commission" | "volume" | "per-sale" | "runway";
export const SORTS: [Sort, string][] = [["newest", "Newest"], ["per-sale", "Most per sale"], ["runway", "Longest runway"], ["commission", "Highest commission"], ["volume", "Most settled volume"]];

/** Stable sort; campaigns whose value is unknown always go last. The API's own order is "newest". */
export function sortItems(items: Campaign[], sort: Sort): Campaign[] {
  const idx = new Map(items.map((c, i) => [c.address, i]));
  const key = (c: Campaign): bigint | null =>
    sort === "commission" ? BigInt(c.commissionBps) : sort === "volume" ? BigInt(c.volume ?? "0") : sort === "per-sale" ? earnPerSale(c) : (() => { const r = runwaySales(c); return r === null ? null : BigInt(r); })();
  if (sort === "newest") return [...items];
  return [...items].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka === null && kb === null) return idx.get(a.address)! - idx.get(b.address)!;
    if (ka === null) return 1; if (kb === null) return -1;
    return ka === kb ? idx.get(a.address)! - idx.get(b.address)! : ka > kb ? -1 : 1;
  });
}

export interface Filters { q: string; category: string | null; budgetLeft: boolean; runway1000: boolean; noRefunds: boolean }
export const RUNWAY_MIN = 1000;

export function matches(c: Campaign, f: Filters): boolean {
  const l = c.listing;
  if (f.category && l?.category !== f.category) return false;
  if (f.budgetLeft && c.status !== "active") return false;
  if (f.runway1000 && !((runwaySales(c) ?? 0) >= RUNWAY_MIN)) return false;
  if (f.noRefunds && c.sales.refunded > 0) return false;
  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = [l?.name, l?.description, l?.route, l?.endpointUrl, l ? CATEGORIES[l.category] : "", c.merchant].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Counts per category over the given list (the chips show how many campaigns each has). */
export function categoryCounts(items: Campaign[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of items) { const k = c.listing?.category; if (k) out[k] = (out[k] ?? 0) + 1; }
  return out;
}
