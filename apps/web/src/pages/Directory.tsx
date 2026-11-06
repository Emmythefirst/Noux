import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { st } from "../lib/css";
import { API_BASE, useApi, useCopy, useIndexFreshness, type Campaign, type CampaignDetail, type Page as ApiPage, type Stats } from "../lib/api";
import { CATEGORIES, bpsPct, fmt2, fmtAmount, short } from "../lib/format";
import { RUNWAY_MIN, SORTS, categoryCounts, directoryTotals, earnPerSale, isOpen, matches, refundText, runwaySales, singlePrice, sortItems, splitOf, type Filters, type Sort } from "../lib/directory";
import { isPubkey, useWalletAddress } from "../lib/wallet";
import { referralLink } from "../lib/buy";
import { useWallet } from "../lib/wallet-connect";
import { Disclosure, ErrorState, Freshness, Page, SampleBadge, SkeletonCards, StateBadge, TopNav, WakingBanner } from "../components/common";

const CAT_CHIPS: [string, string | null][] = [["All", null], ["AI and text", "ai-text"], ["Research and search", "research-search"], ["Data feeds", "data-feeds"], ["Developer tools", "developer-tools"]];
const VIEW_KEY = "noux.dirview";
const COLS = "minmax(220px, 2.3fr) 96px minmax(130px, 1.1fr) minmax(150px, 1.3fr) 120px 84px 24px";
const CLAMP2 = { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as const;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
function useMedia(query: string): boolean {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => { const mq = window.matchMedia(query); const on = () => setM(mq.matches); on(); mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }, [query]);
  return m;
}

// ---------- small building blocks ----------
const ICONS: Record<string, string> = {
  "developer-tools": "M8 7 3 12l5 5M16 7l5 5-5 5M14 5l-4 14",
  "research-search": "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  "data-feeds": "M5 20V10M12 20V4M19 20v-7",
  "ai-text": "M5 6h14M5 11h14M5 16h9",
  other: "M12 5v14M5 12h14",
};
const CatIcon = ({ category, size = 36 }: { category?: string; size?: number }) => (
  <div aria-hidden="true" style={{ ...st("flex: none; border-radius: 10px; background: #F4F4F5; display: flex; align-items: center; justify-content: center; color: #0F766E;"), width: size, height: size }}>
    <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[category ?? "other"] ?? ICONS.other} /></svg>
  </div>
);

/** Where one sale's money goes: merchant (black), you (teal), protocol fee (grey). Segments are proportional to the amounts. */
function SplitBar({ merchant, you, fee, height = 6, label }: { merchant: number; you: number; fee: number; height?: number; label: string }) {
  const seg = (n: number) => ({ flex: `${Math.max(n, 0)} 1 0`, minWidth: n > 0 ? 3 : 0 });
  return (
    <div role="img" aria-label={label} style={{ ...st("display: flex; gap: 2px; border-radius: 9999px; overflow: hidden; width: 100%;"), height }}>
      <div style={{ ...seg(merchant), background: "#111111" }} /><div style={{ ...seg(you), background: "#0F766E" }} /><div style={{ ...seg(fee), background: "#D4D4D8" }} />
    </div>
  );
}
function campaignSplit(c: Campaign) {
  const price = singlePrice(c.listing?.displayPrice, c.decimals);
  if (price !== null) { const s = splitOf(price, c.commissionBps, c.feeBps, BigInt(c.budget.remaining)); return { exact: true as const, price, ...s, merchantN: Number(s.merchant), youN: Number(s.commission), feeN: Number(s.fee) }; }
  return { exact: false as const, merchantN: 10000 - c.commissionBps - c.feeBps, youN: c.commissionBps, feeN: c.feeBps };
}
const splitLabel = (c: Campaign) => { const s = campaignSplit(c); const t = s.merchantN + s.youN + s.feeN || 1; return `Each sale splits about ${Math.round((s.merchantN / t) * 100)}% merchant, ${Math.round((s.youN / t) * 100)}% you, ${Math.round((s.feeN / t) * 100)}% protocol fee`; };

/** Settled sales per day for 14 days (oldest first). Without data (older API) it shows a dash. */
function Spark({ daily }: { daily?: number[] }) {
  if (!daily) return <span style={st("font-size: 12px; color: #6B6B6B;")}>—</span>;
  const total = daily.reduce((a, b) => a + b, 0), max = Math.max(1, ...daily);
  const label = `Settled sales per day over the last 14 days: ${total} in total`;
  if (total === 0) return <div role="img" aria-label={label} style={st("height: 24px; width: 100%; display: flex; align-items: flex-end;")}><div style={st("width: 100%; border-bottom: 2px dotted #D4D4D8;")} /></div>;
  return (
    <div role="img" aria-label={label} style={st("height: 24px; width: 100%; display: flex; align-items: flex-end; gap: 2px;")}>
      {daily.map((n, i) => <div key={i} style={{ flex: 1, height: n === 0 ? 2 : Math.max(4, Math.round((n / max) * 24)), background: n === 0 ? "#EBEBEB" : "#111111", borderRadius: "1px 1px 0 0" }} />)}
    </div>
  );
}

function RunwayCell({ c }: { c: Campaign }) {
  const open = isOpen(c), r = runwaySales(c), total = BigInt(c.budget.total);
  const pct = total > 0n ? Number((BigInt(c.budget.remaining) * 100n) / total) : 0;
  return (
    <div style={st("display: flex; flex-direction: column; gap: 6px; min-width: 0;")}>
      <span className="tn" style={st("font-size: 13px; color: #333333;")}>
        {c.status === "budget_exhausted" ? "Budget spent · 0 sales left" : r !== null ? `≈ ${r.toLocaleString("en-US")} sales left` : `${fmt2(c.budget.remaining)} USDC left`}
      </span>
      <div aria-hidden="true" style={st("height: 3px; border-radius: 9999px; background: #F4F4F5; overflow: hidden;")}><div style={{ ...st("height: 100%; border-radius: 9999px;"), width: `${pct}%`, background: !open ? "#D4D4D8" : pct < 15 ? "#8A4B00" : "#0F766E" }} /></div>
    </div>
  );
}

function StatusMark({ c }: { c: Campaign }) {
  if (c.state === "paused" || c.state === "ended") return <StateBadge state={c.state} />;
  if (c.status === "budget_exhausted") return <span style={st("flex: none; height: 20px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; background: #FFF1D6; color: #8A4B00;")}>Budget spent</span>;
  return null;
}

function useMyLink(c: Campaign) {
  const [saved] = useWalletAddress(); const cw = useWallet();
  const wallet = saved || cw.address || "";
  return isPubkey(wallet) ? referralLink(c.address, wallet) : null;
}

// ---------- list view ----------
function ListRow({ c, openRow, onToggle, copied, copy }: { c: Campaign; openRow: boolean; onToggle: () => void; copied: string | null; copy: (k: string, t: string) => void }) {
  const l = c.listing, name = l?.name ?? "Unlisted campaign", live = isOpen(c);
  const earn = earnPerSale(c), price = singlePrice(l?.displayPrice, c.decimals), split = campaignSplit(c);
  const detail = useApi<CampaignDetail>(openRow ? `/campaigns/${c.address}` : null);
  const link = useMyLink(c);
  const panelId = `row-${c.address}`;
  return (
    <li style={{ ...st("border-bottom: 1px solid #EBEBEB;"), opacity: live ? 1 : 0.62 }}>
      <button type="button" className="rh press" aria-expanded={openRow} aria-controls={panelId} onClick={onToggle}
        style={{ ...st("width: 100%; display: grid; align-items: center; gap: 16px; padding: 14px 16px; border: 0; background: transparent; text-align: left; cursor: pointer; font: 400 14px Inter, sans-serif; color: #333333;"), gridTemplateColumns: COLS }}>
        <span style={st("display: flex; align-items: center; gap: 12px; min-width: 0;")}>
          <CatIcon category={l?.category} />
          <span style={st("display: flex; flex-direction: column; gap: 2px; min-width: 0;")}>
            <span style={st("display: flex; align-items: center; gap: 8px; min-width: 0;")}>
              <span style={st("font-size: 14px; font-weight: 500; color: #111111; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;")}>{name}</span>
              {l?.isSample && <SampleBadge />}<StatusMark c={c} />
            </span>
            <span style={st("font-size: 12px; color: #6B6B6B; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;")}>
              {l?.route && <span className="mono">{l.route}</span>}{l?.route && " · "}{l ? CATEGORIES[l.category] ?? l.category : "Unlisted"}
            </span>
          </span>
        </span>
        <span className="tn" style={st("font-size: 14px; color: #111111;")}>{l?.displayPrice ?? "—"}<span style={st("font-size: 12px; color: #6B6B6B;")}> /call</span></span>
        <span style={st("display: flex; flex-direction: column; gap: 6px; min-width: 0;")}>
          <span className="tn" style={st("display: flex; align-items: baseline; gap: 8px;")}>
            <span style={st("font-size: 16px; font-weight: 500; color: #0F766E;")}>{earn !== null ? fmtAmount(earn, c.decimals).replace(/0{1,2}$/, "") : `${bpsPct(c.commissionBps, c.commissionBps % 100 ? 2 : 0)}`}</span>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>{earn !== null ? `· ${bpsPct(c.commissionBps, c.commissionBps % 100 ? 2 : 0)}` : "of each sale"}</span>
          </span>
          <SplitBar merchant={split.merchantN} you={split.youN} fee={split.feeN} label={splitLabel(c)} />
        </span>
        <RunwayCell c={c} />
        <Spark daily={c.daily} />
        <span className="tn" style={st("font-size: 13px; color: #333333;")}>{refundText(c)}</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "transform 160ms", transform: openRow ? "rotate(180deg)" : "none" }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {openRow && (
        <div id={panelId} className="fadein" style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 24px 32px; padding: 4px 16px 24px 64px;")}>
          <div style={st("display: flex; flex-direction: column; gap: 16px; min-width: 0;")}>
            <p style={st("font-size: 14px; line-height: 20px; color: #333333; max-width: 520px;")}>{l?.description ?? "This campaign has no signed listing."}</p>
            <div style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 420px;")}>
              <span style={st("font-size: 12px; color: #6B6B6B;")}>{price !== null ? `One ${fmtAmount(price, c.decimals)} USDC sale splits like this` : "Each sale splits like this (shares of the price)"}</span>
              <SplitBar merchant={split.merchantN} you={split.youN} fee={split.feeN} height={12} label={splitLabel(c)} />
              <div className="tn" style={st("display: flex; justify-content: space-between; gap: 12px; font-size: 12px;")}>
                {([["Merchant", split.exact ? fmtAmount(split.merchant, c.decimals) : bpsPct(split.merchantN, 0), "#111111"], ["You", split.exact ? fmtAmount(split.commission, c.decimals) : bpsPct(split.youN, split.youN % 100 ? 2 : 0), "#0F766E"], ["Fee", split.exact ? fmtAmount(split.fee, c.decimals) : bpsPct(split.feeN, split.feeN % 100 ? 2 : 0), "#6B6B6B"]] as const).map(([k, v, col]) => (
                  <span key={k} style={st("display: flex; flex-direction: column; gap: 2px;")}><span style={st("color: #6B6B6B;")}>{k}</span><span style={{ ...st("font-size: 14px; font-weight: 500;"), color: col }}>{v}</span></span>
                ))}
              </div>
            </div>
          </div>
          <dl className="tn" style={st("margin: 0; display: flex; flex-direction: column; font-size: 13px; min-width: 0;")}>
            {([
              ["Merchant", <a key="m" className="mono" href={`https://explorer.solana.com/address/${c.merchant}?cluster=devnet`} target="_blank" rel="noreferrer" style={st("font-size: 12px;")}>{short(c.merchant)}</a>],
              ["Refund hold", `${c.holdSecs} s`],
              ["Settled sales · buyers", detail.data ? `${detail.data.metrics.settled} · ${detail.data.metrics.distinctBuyers}` : detail.error ? `${c.sales.settled} · —` : "…"],
              ["Commission budget", `${fmt2(c.budget.remaining)} of ${fmt2(c.budget.total)} USDC`],
            ] as const).map(([k, v], i, a) => (
              <div key={k} style={st("display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; " + (i < a.length - 1 ? "border-bottom: 1px solid #EBEBEB;" : ""))}><dt style={st("color: #6B6B6B;")}>{k}</dt><dd style={st("margin: 0; color: #111111;")}>{v}</dd></div>
            ))}
          </dl>
          <div style={st("display: flex; flex-direction: column; gap: 10px; min-width: 0;")}>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>Your referral link</span>
            {link ? (
              <div style={st("display: flex; gap: 8px;")}>
                <input readOnly aria-label="Your referral link" className="mono" value={link} onFocus={(e) => e.currentTarget.select()} style={st("flex: 1; min-width: 0; height: 36px; padding: 0 10px; border: 1px solid #8A8A8A; border-radius: 8px; font-size: 12px; color: #111111; background: #FFFFFF;")} />
                <button type="button" className="press bi tap" onClick={() => copy(c.address, link)} style={st("flex: none; height: 36px; padding: 0 14px; border: 0; border-radius: 8px; background: #111111; color: #FFFFFF; font: 500 13px Inter, sans-serif; cursor: pointer;")}>{copied === c.address ? "Copied" : "Copy link"}</button>
              </div>
            ) : (
              <p style={st("font-size: 13px; line-height: 19px; color: #333333;")}>Your wallet address is your referral ID. <Link to={`/campaigns/${c.address}#promote`}>Add it on the campaign page</Link> to get your link.</p>
            )}
            <div style={st("display: flex; flex-wrap: wrap; gap: 4px 20px; font-size: 13px; font-weight: 500;")}>
              <Link to={`/campaigns/${c.address}`}>Open campaign →</Link>
              <Link to="/docs/agents-and-claims">Agent claim snippet</Link>
            </div>
            <span style={st("font-size: 12px; line-height: 17px; color: #6B6B6B;")}>Distributors earn a commission on this campaign.</span>
          </div>
        </div>
      )}
    </li>
  );
}

// ---------- card view ----------
function CampaignCard({ c, copied, copy }: { c: Campaign; copied: string | null; copy: (k: string, t: string) => void }) {
  const l = c.listing, name = l?.name ?? "Unlisted campaign", live = isOpen(c), earn = earnPerSale(c), split = campaignSplit(c), link = useMyLink(c);
  return (
    <article className="ch press fadein" style={{ ...st("display: flex; flex-direction: column; border: 2px solid #D4D4D8; border-radius: 14px; background: #FFFFFF; overflow: hidden;"), opacity: live ? 1 : 0.7 }}>
      <Link to={`/campaigns/${c.address}`} aria-label={`${name}: view campaign`} style={st("flex: 1; display: flex; flex-direction: column; gap: 16px; padding: 20px; color: #333333;")}>
        <div style={st("display: flex; align-items: flex-start; gap: 12px;")}>
          <CatIcon category={l?.category} />
          <div style={st("flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;")}>
            <div style={st("display: flex; align-items: center; gap: 8px; min-width: 0;")}>
              <h2 style={st("font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;")}>{name}</h2>
              {l?.isSample && <SampleBadge />}
            </div>
            <span style={st("font-size: 12px; color: #6B6B6B; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;")}>{l?.route && <span className="mono">{l.route}</span>}{l?.route && " · "}{l ? CATEGORIES[l.category] ?? l.category : "Unlisted"}</span>
          </div>
          <StatusMark c={c} />
        </div>
        <p style={{ ...st("font-size: 14px; line-height: 20px; color: #333333; text-wrap: pretty; min-height: 40px;"), ...CLAMP2 }}>{l?.description ?? "This campaign has no signed listing."}</p>
        <div style={st("background: #F4F4F5; border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;")}>
          <div className="tn" style={st("display: flex; align-items: baseline; justify-content: space-between; gap: 8px;")}>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>You earn / sale</span>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>{l?.displayPrice ?? "—"} /call</span>
          </div>
          <div className="tn" style={st("display: flex; align-items: baseline; gap: 8px;")}>
            <span style={st("font-size: 24px; line-height: 28px; font-weight: 500; letter-spacing: -0.02em; color: #0F766E;")}>{earn !== null ? fmtAmount(earn, c.decimals).replace(/0{1,2}$/, "") : bpsPct(c.commissionBps, c.commissionBps % 100 ? 2 : 0)}</span>
            <span style={st("font-size: 13px; color: #6B6B6B;")}>{earn !== null ? `USDC · ${bpsPct(c.commissionBps, c.commissionBps % 100 ? 2 : 0)}` : "of each sale"}</span>
          </div>
          <SplitBar merchant={split.merchantN} you={split.youN} fee={split.feeN} label={splitLabel(c)} />
        </div>
        <RunwayCell c={c} />
        <div style={st("display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;")}>
          <div style={st("width: 120px;")}><Spark daily={c.daily} /></div>
          <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>{c.holdSecs} s hold · refunds {refundText(c)}</span>
        </div>
      </Link>
      <div style={st("border-top: 1px solid #EBEBEB; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px;")}>
        {link
          ? <button type="button" className="press bi tap" onClick={() => copy(c.address, link)} style={st("height: 32px; padding: 0 14px; border: 0; border-radius: 9999px; background: #111111; color: #FFFFFF; font: 500 13px Inter, sans-serif; cursor: pointer;")}>{copied === c.address ? "Link copied" : "Get referral link"}</button>
          : <Link className="press bi tap" to={`/campaigns/${c.address}#promote`} style={st("height: 32px; padding: 0 14px; border-radius: 9999px; background: #111111; color: #FFFFFF; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center;")}>Get referral link</Link>}
        <Link className="tap" to={`/campaigns/${c.address}`} style={st("font-size: 13px; font-weight: 500; display: inline-flex; align-items: center;")}>View campaign →</Link>
      </div>
    </article>
  );
}

// ---------- page ----------
export default function Directory() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("newest");
  const [quick, setQuick] = useState({ budgetLeft: false, runway1000: false, noRefunds: false });
  const [view, setView] = useState<"list" | "grid">(() => { try { return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list"; } catch { return "list"; } });
  const [openAddr, setOpenAddr] = useState<string | null>(null);
  const narrow = useMedia("(max-width: 900px)");
  const [copied, copy] = useCopy();
  const dq = useDebounced(q, 200);

  const list = useApi<ApiPage<Campaign>>("/campaigns?limit=100&sort=newest");
  const stats = useApi<Stats>("/stats");
  const fresh = useIndexFreshness();
  const all = list.data?.items ?? [];
  const filters: Filters = { q: dq, category: cat, ...quick };
  const items = sortItems(all.filter((c) => matches(c, filters)), sort);
  const inCat = (c: Campaign) => matches(c, { ...filters, category: null });
  const counts = categoryCounts(all.filter(inCat));
  const totals = directoryTotals(all);
  const vs = stats.data?.volumeBySource, dec = stats.data?.decimals ?? 6;
  const showView = narrow ? "grid" : view;
  const anyFilter = !!(cat || dq || quick.budgetLeft || quick.runway1000 || quick.noRefunds);
  const clear = () => { setQ(""); setCat(null); setQuick({ budgetLeft: false, runway1000: false, noRefunds: false }); };
  const pick = (v: "list" | "grid") => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage may be blocked */ } };

  const chip = (on: boolean, extra = "") => st(`height: 32px; padding: 0 12px; border-radius: 9999px; font: 500 13px Inter, sans-serif; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; ${on ? "background: #111111; color: #FFFFFF; border: 1px solid #111111;" : "background: #FFFFFF; color: #333333; border: 1px solid #D4D4D8;"} ${extra}`);

  return (
    <Page>
      <TopNav cta />
      <main style={st("max-width: 1280px; margin: 0 auto; padding: 48px clamp(16px, 4vw, 48px) 80px; display: flex; flex-direction: column; gap: 24px;")}>
        <div style={st("display: flex; flex-wrap: wrap; gap: 24px; align-items: end; justify-content: space-between;")}>
          <div style={st("display: flex; flex-direction: column; gap: 10px; max-width: 640px;")}>
            <h1 style={st("font-size: clamp(2rem, 1.4rem + 2vw, 2.75rem); line-height: 1.05; letter-spacing: -0.03em; font-weight: 500; color: #111111;")}>Campaigns <span style={st("color: #6B6B6B;")}>that pay you per buyer.</span></h1>
            <p style={st("font-size: 16px; line-height: 24px; color: #333333;")}>Paid x402 services with a live commission budget. Pick one, share it, and get paid at settlement. Every number is read from the chain.</p>
          </div>
          <div style={st("display: flex; flex-direction: column; align-items: flex-end; gap: 8px;")}>
            <Freshness ageSeconds={fresh.info?.ageSeconds} fetchedAt={fresh.fetchedAt} now={fresh.now} error={fresh.error} />
            <a className="mono" href={`${API_BASE}/campaigns`} target="_blank" rel="noreferrer" style={st("font-size: 12px; color: #333333; border: 1px solid #D4D4D8; border-radius: 6px; padding: 4px 8px;")}>GET /v1/campaigns ↗</a>
          </div>
        </div>

        <section aria-label="Directory totals" style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); border: 1px solid #EBEBEB; border-radius: 12px; overflow: hidden;")}>
          {([
            ["Open campaigns", list.data ? <><span>{totals.open}</span> <span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>of {totals.listed} listed</span></> : "—", false],
            ["Commission budget available", list.data ? <><span>{fmt2(totals.budgetAvailable, dec)}</span> <span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>USDC</span></> : "—", false],
            ["Settled volume · real services", vs && vs.listed.settled > 0 ? <><span>{fmt2(vs.listed.volume, dec)}</span> <span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>USDC</span></> : "—", false],
            [<span key="s" style={st("display: inline-flex; align-items: center; gap: 8px;")}>Settled volume · <SampleBadge style={{ border: "1px solid #EBEBEB" }} /></span>, vs ? <><span>{fmt2(vs.sample.volume, dec)}</span> <span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>USDC</span></> : "—", true],
          ] as const).map(([k, v, shaded], i, a) => (
            <div key={i} style={st("padding: 12px 20px; display: flex; flex-direction: column; gap: 4px; " + (i < a.length - 1 ? "border-right: 1px solid #EBEBEB; " : "") + (shaded ? "background: #FAFAFA;" : ""))}>
              <span style={st("font-size: 13px; font-weight: 500; color: #6B6B6B;")}>{k}</span>
              <span className="tn" style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.02em; font-weight: 500; color: #111111;")}>{v}</span>
            </div>
          ))}
        </section>

        {/* Toolbar: pinned under the top bar while the list scrolls (not on phones, where it is three rows tall) */}
        <div style={{ ...st("z-index: 10; background: #FFFFFF; padding: 12px 0; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid #EBEBEB;"), ...(narrow ? {} : { position: "sticky", top: 60 }) }}>
          <div style={st("display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center;")}>
            <div style={st("position: relative; flex: 1 1 260px; min-width: 0;")}>
              <label htmlFor="q" className="vh">Search campaigns</label>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.5" aria-hidden="true" style={st("position: absolute; left: 12px; top: 12px;")}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input id="q" type="search" autoComplete="off" placeholder="Search services, endpoints or merchants" value={q} onChange={(e) => setQ(e.target.value)}
                style={st("width: 100%; height: 40px; padding: 0 12px 0 36px; border: 1px solid #8A8A8A; border-radius: 8px; font: 400 14px Inter, sans-serif; color: #111111; background: #FFFFFF;")} />
            </div>
            <button type="button" className="press chip" aria-pressed={quick.budgetLeft} onClick={() => setQuick((s) => ({ ...s, budgetLeft: !s.budgetLeft }))} style={chip(quick.budgetLeft)}>Budget left</button>
            <button type="button" className="press chip" aria-pressed={quick.runway1000} onClick={() => setQuick((s) => ({ ...s, runway1000: !s.runway1000 }))} style={chip(quick.runway1000)}>{RUNWAY_MIN.toLocaleString("en-US")}+ sales of runway</button>
            <button type="button" className="press chip" aria-pressed={quick.noRefunds} onClick={() => setQuick((s) => ({ ...s, noRefunds: !s.noRefunds }))} style={chip(quick.noRefunds)}>No refunds yet</button>
            <div style={st("display: flex; align-items: center; gap: 8px; margin-left: auto;")}>
              <label htmlFor="sort" className="vh">Sort</label>
              <div style={st("position: relative;")}>
                <select id="sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} style={st("height: 40px; padding: 0 36px 0 12px; border: 1px solid #8A8A8A; border-radius: 8px; font: 500 13px Inter, sans-serif; color: #111111; background: #FFFFFF; cursor: pointer;")}>
                  {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#333333" strokeWidth="1.5" aria-hidden="true" style={st("position: absolute; right: 12px; top: 13px; pointer-events: none;")}><path d="m6 9 6 6 6-6" /></svg>
              </div>
              {!narrow && (
                <div role="group" aria-label="View" style={st("display: inline-flex; border: 1px solid #D4D4D8; border-radius: 8px; overflow: hidden;")}>
                  {([["list", "List view", "M4 6h16M4 12h16M4 18h16"], ["grid", "Card view", "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"]] as const).map(([v, label, d]) => (
                    <button key={v} type="button" aria-pressed={view === v} aria-label={label} title={label} onClick={() => pick(v)} className="press"
                      style={st(`width: 38px; height: 38px; border: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; ${view === v ? "background: #F4F4F5; color: #111111;" : "background: #FFFFFF; color: #6B6B6B;"}`)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div role="group" aria-label="Category" style={st("display: flex; flex-wrap: wrap; gap: 8px;")}>
            {CAT_CHIPS.map(([label, value]) => {
              const on = cat === value, n = value === null ? all.filter(inCat).length : counts[value] ?? 0;
              return <button key={label} className="press chip" type="button" aria-pressed={on} onClick={() => setCat(value)} style={chip(on, "height: 28px;")}>{label}{list.data && <span className="tn" style={{ opacity: 0.7 }}>{n}</span>}</button>;
            })}
          </div>
        </div>

        <div style={st("display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; font-size: 13px; color: #6B6B6B;")} role="status">
          <span className="tn">{list.data ? `${items.length} of ${all.length} campaigns${list.data.total > all.length ? ` (first ${all.length} of ${list.data.total})` : ""} · amounts in USDC` : ""}</span>
          <span style={st("display: inline-flex; align-items: center; gap: 14px;")} aria-label="Split bar legend">
            {([["Merchant", "#111111"], ["You", "#0F766E"], ["Fee", "#D4D4D8"]] as const).map(([k, col]) => <span key={k} style={st("display: inline-flex; align-items: center; gap: 6px;")}><span aria-hidden="true" style={{ width: 10, height: 6, borderRadius: 2, background: col }} />{k}</span>)}
          </span>
        </div>

        {list.loading && (list.waking ? <><WakingBanner /><SkeletonCards /></> : <SkeletonCards />)}
        {list.error && <ErrorState title="Couldn’t load campaigns" onRetry={list.retry} />}
        {list.data && items.length > 0 && showView === "list" && (
          <div style={st("border: 1px solid #EBEBEB; border-radius: 12px; overflow: hidden;")}>
            <div aria-hidden="true" className="tn" style={{ ...st("display: grid; align-items: center; gap: 16px; padding: 10px 16px; font-size: 12px; color: #6B6B6B; background: #FAFAFA; border-bottom: 1px solid #EBEBEB;"), gridTemplateColumns: COLS }}>
              <span>Service</span><span>Price / call</span><span>You earn / sale</span><span>Budget runway</span><span>Last 14 days</span><span>Refunds</span><span />
            </div>
            <ul style={st("list-style: none; margin: 0; padding: 0;")}>
              {items.map((c) => <ListRow key={c.address} c={c} openRow={openAddr === c.address} onToggle={() => setOpenAddr((a) => (a === c.address ? null : c.address))} copied={copied} copy={copy} />)}
            </ul>
          </div>
        )}
        {list.data && items.length > 0 && showView === "grid" && (
          <div style={st("display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 16px;")}>
            {items.map((c) => <CampaignCard key={c.address} c={c} copied={copied} copy={copy} />)}
          </div>
        )}
        {list.data && items.length === 0 && (
          <div style={st("display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; padding: 72px 24px; border: 1px dashed #D4D4D8; border-radius: 12px;")}>
            <div style={st("width: 44px; height: 44px; border-radius: 12px; background: #F4F4F5; display: flex; align-items: center; justify-content: center;")}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#333333" strokeWidth="1.5" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg></div>
            <h2 style={st("font-size: 16px; font-weight: 500; color: #111111;")}>{anyFilter ? "No campaigns match" : "No campaigns are listed yet"}</h2>
            <p style={st("font-size: 14px; color: #6B6B6B; max-width: 380px;")}>{anyFilter ? "Try another category or clear your filters. Selling a paid endpoint yourself? List it here." : "Selling a paid endpoint? Be the first to list it here."}</p>
            {anyFilter && <button className="press bs" type="button" onClick={clear} style={st("height: 32px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;")}>Clear filters</button>}
          </div>
        )}

        <Link className="ch press" to="/app/merchant" style={st("display: flex; flex-wrap: wrap; align-items: center; gap: 16px; justify-content: space-between; padding: 20px 24px; border: 1px dashed #D4D4D8; border-radius: 12px; color: #333333;")}>
          <div style={st("display: flex; flex-direction: column; gap: 4px;")}><span style={st("font-size: 16px; font-weight: 500; color: #111111; letter-spacing: -0.01em;")}>Sell a paid x402 endpoint?</span><span style={st("font-size: 14px; color: #6B6B6B;")}>Create a campaign and let people and agents bring you buyers.</span></div>
          <span style={st("height: 32px; padding: 0 12px; border-radius: 10px; background: #0F766E; color: #FFFFFF; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center;")}>Create campaign</span>
        </Link>

        <Disclosure text={list.data?.disclosure ?? stats.data?.disclosure} style={{ borderTop: "1px solid #EBEBEB", paddingTop: 24 }} />
      </main>
    </Page>
  );
}
