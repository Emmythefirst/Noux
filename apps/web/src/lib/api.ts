import { useCallback, useEffect, useRef, useState } from "react";

export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "https://noux-api.onrender.com/v1";
export const EXPLORER_CLUSTER = "?cluster=devnet";
export const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}${EXPLORER_CLUSTER}`;

export interface Listing {
  name: string; description: string; category: string; endpointUrl: string; route: string;
  displayPrice: string; website?: string | null; isSample: boolean; updatedAt: string | null;
}
export interface Campaign {
  address: string; merchant: string; mint: string; decimals: number; cluster: string;
  commissionBps: number; feeBps: number; holdSecs: number;
  attributionKey?: string;
  feeOwner: string; feeEnforced: boolean | null;
  budget: { total: string; spent: string; remaining: string };
  status: "active" | "budget_exhausted";
  sales: { settled: number; refunded: number; open: number; refundRate: number | null };
  volume?: string; listing: Listing | null; links: { account: string };
}
export interface CampaignDetail extends Campaign {
  disclosure: string;
  metrics: {
    settled: number; refunded: number; open: number; volume: string; commissionsPaid: string; protocolFees: string;
    merchantRevenue: string; refundedAmount: string; distinctBuyers: number; distinctDistributors: number; topBuyerShare: number;
  };
  topDistributors: { distributor: string; purchases: number; earned: string }[];
}
export interface Receipt {
  sale: string; campaign: string; status: "open" | "settled" | "refunded"; cluster: string; decimals: number;
  parties: { merchant: string; distributor: string; buyer: string; feeOwner?: string };
  price: string; gross: string;
  /** gross is 0 for an open sale until settlement; vaultAmount is what has been paid in so far */
  vaultAmount: string; funded: boolean;
  split: { merchant: string; distributor: string; protocolFee: string };
  policy: { commissionBps: number; feeBps: number; holdSecs: number; rounding: string; budgetCapApplied: boolean };
  refunded: boolean; openedAt: string | null; settledAt: string | null; holdUntil: string | null;
  links: { saleAccount: string; open: string | null; payment: string | null; settlement: string | null; refund: string | null };
  listing: Listing | null;
}
export interface Page<T> { items: T[]; total: number; limit: number; offset: number; disclosure?: string }
export interface Stats {
  cluster: string; programId: string; decimals: number; disclosure: string;
  protocol: { admin: string; feeOwner: string; feeBps: number; maxFeeBps: number } | null;
  totals: { campaigns: number; listedCampaigns: number; merchants: number; settled: number; refunded: number; open: number; volume: string; commissionsPaid: string; protocolFees: string; refundedAmount: string; distinctBuyers: number; distinctDistributors: number };
  volumeBySource: { sample: { settled: number; volume: string }; listed: { settled: number; volume: string }; unlisted: { settled: number; volume: string } };
  index: { lastSyncedAt: string | null; ageSeconds: number | null; lastSlot: number | null; lastError: string | null };
}
export interface IndexInfo { lastSyncedAt: string | null; ageSeconds: number | null; lastSlot: number | null; campaigns: number; sales: number; lastError: string | null; lastErrorAt: string | null }
export interface DistributorInfo {
  distributor: string; decimals: number; disclosure: string;
  metrics: { eligiblePurchases: number; refunded: number; open: number; totalEarned: string; referredVolume: string; distinctBuyers: number; campaigns: number; topBuyerShare: number };
  claims: { issued: number; paid: number };
  byCampaign: { campaign: string; purchases: number; earned: string }[];
  recent: Receipt[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Free Render services sleep when idle and take up to ~60 s to wake: give them 65 s before giving up. */
const TIMEOUT_MS = 65_000;
const WAKING_AFTER_MS = 2_500;

/** `fresh` bypasses the browser cache (the API allows a few seconds of caching: right after a write the old copy must not come back). */
export async function apiGet<T>(path: string, signal?: AbortSignal, fresh = false): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const r = await fetch(API_BASE + path, { signal: ctl.signal, cache: fresh ? "reload" : "default" });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = ((await r.json()) as any)?.error?.message ?? msg; } catch { /* keep default */ }
      throw new ApiError(r.status, msg);
    }
    return (await r.json()) as T;
  } finally { clearTimeout(timer); }
}

export interface Fetched<T> { data: T | null; error: ApiError | Error | null; loading: boolean; waking: boolean; retry: () => void }

/** GET with loading / waking (cold start) / error states. `path = null` skips the request. */
export function useApi<T>(path: string | null): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [waking, setWaking] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    const mine = ++seq.current;
    const ctl = new AbortController();
    setLoading(true); setError(null); setWaking(false);
    const w = setTimeout(() => { if (seq.current === mine) setWaking(true); }, WAKING_AFTER_MS);
    apiGet<T>(path, ctl.signal, tick > 0) // a retry (after an error or a write) must not be served from cache
      .then((d) => { if (seq.current === mine) { setData(d); setLoading(false); setWaking(false); } })
      .catch((e: Error) => {
        if (ctl.signal.aborted || seq.current !== mine) return; // superseded or unmounted
        setError(e.name === "AbortError" ? new Error("The index took too long to answer.") : e);
        setLoading(false); setWaking(false);
      });
    return () => { clearTimeout(w); ctl.abort(); };
  }, [path, tick]);

  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, waking, retry };
}

/** Re-render every `ms` (countdowns, "12 s ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>();
  const copy = useCallback((key: string, text: string) => {
    try { void navigator.clipboard?.writeText(text); } catch { /* clipboard may be blocked; the label still confirms intent only if it worked */ return; }
    setCopied(key);
    clearTimeout(t.current);
    t.current = setTimeout(() => setCopied(null), 1800);
  }, []);
  return [copied, copy];
}

/** Index freshness for the "Indexed N s ago" indicator. Records when it was fetched so the age can tick. */
export function useIndexFreshness() {
  const r = useApi<IndexInfo>("/index");
  const [at, setAt] = useState(Date.now());
  useEffect(() => { if (r.data) setAt(Date.now()); }, [r.data]);
  const now = useNow(1000);
  return { info: r.data, fetchedAt: at, now, error: r.data?.lastError ?? null };
}
