import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { st } from "../lib/css";
import { useApi, useIndexFreshness, type Campaign, type Page as ApiPage, type Stats } from "../lib/api";
import { CATEGORIES, bpsPct, fmt2, fmtAmount, initials, short } from "../lib/format";
import { Disclosure, ErrorState, Freshness, Page, SampleBadge, SkeletonCards, StatusChip, TopNav, WakingBanner } from "../components/common";

const CAT_CHIPS: [string, string | null][] = [["All", null], ["AI and text", "ai-text"], ["Research and search", "research-search"], ["Data feeds", "data-feeds"], ["Developer tools", "developer-tools"]];
const SORTS: [string, string][] = [["newest", "Newest"], ["commission", "Highest commission"], ["volume", "Most settled volume"]];

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** "$0.015 on a $0.10 sale" for a single listed price; null for ranges or prices we cannot read (never guess). */
function commissionExample(displayPrice: string | undefined, bps: number): string | null {
  const m = displayPrice && /^\$?\s*(\d+(?:\.\d+)?)\s*(?:USDC)?(?:\s*\/.*)?$/i.exec(displayPrice.trim());
  if (!m) return null;
  const units = Math.round(Number(m[1]) * 1e6);
  const comm = Math.floor((units * bps) / 10000);
  const trim = (u: number) => (u / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.(\d)$/, ".$10");
  return `$${trim(comm)} on a $${trim(units)} sale`;
}

const CLAMP2 = { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as const;

function CampaignCard({ c }: { c: Campaign }) {
  const spent = c.status === "budget_exhausted";
  const total = BigInt(c.budget.total);
  const pct = total > 0n ? Number((BigInt(c.budget.remaining) * 100n) / total) : 0;
  const l = c.listing;
  const name = l?.name ?? "Unlisted campaign";
  const example = commissionExample(l?.displayPrice, c.commissionBps);
 
  // a refund rate next to "0 sales" reads like a bug; say what happened in plain counts instead
  const refunds = c.sales.settled === 0 ? (c.sales.refunded > 0 ? `${c.sales.refunded} refunded` : null) : c.sales.refundRate === null ? null : `${(c.sales.refundRate * 100).toFixed(c.sales.refundRate === 0 ? 0 : 1)}% refunds`;
  return (
    <article className="ch press fadein" style={st("display: flex; flex-direction: column; border: 1px solid #EBEBEB; border-radius: 12px; background: #FFFFFF; overflow: hidden;")}>
      <Link to={`/campaigns/${c.address}`} aria-label={`${name}: view campaign`} style={st("flex: 1; display: flex; flex-direction: column; gap: 16px; padding: 20px; color: #333333;")}>
        <div style={st("display: flex; align-items: flex-start; gap: 12px;")}>
          <div aria-hidden="true" style={st("width: 36px; height: 36px; flex: none; border-radius: 10px; background: #F4F4F5; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; color: #111111;")}>{initials(name)}</div>
          <div style={st("flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;")}>
            <div style={st("display: flex; align-items: center; gap: 8px; min-width: 0;")}>
              <h2 style={st("font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;")}>{name}</h2>
              {l?.isSample && <SampleBadge />}
            </div>
            <span style={st("font-size: 13px; color: #6B6B6B;")}>{l ? CATEGORIES[l.category] ?? l.category : "—"}</span>
          </div>
          <StatusChip state={c.state} spent={spent} />
        </div>
        <p style={{ ...st("font-size: 14px; line-height: 20px; color: #333333; text-wrap: pretty; min-height: 40px;"), ...CLAMP2 }}>{l?.description ?? "This campaign has no signed listing."}</p>
        <dl className="tn" style={st("margin: 0; padding-top: 16px; border-top: 1px solid #EBEBEB; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px;")}>
          <div style={st("display: flex; flex-direction: column; gap: 2px;")}>
            <dt style={st("font-size: 12px; color: #6B6B6B;")}>Price</dt>
            <dd style={st("margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: #111111;")}>{l?.displayPrice ?? "—"}</dd>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>per call</span>
          </div>
          <div style={st("display: flex; flex-direction: column; gap: 2px;")}>
            <dt style={st("font-size: 12px; color: #6B6B6B;")}>Distributor commission</dt>
            <dd style={st("margin: 0; font-size: 20px; line-height: 24px; font-weight: 500; color: #0F766E;")}>{bpsPct(c.commissionBps, c.commissionBps % 100 ? 2 : 0)}</dd>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>{example ?? "of each eligible sale"}</span>
          </div>
        </dl>
        <div style={st("display: flex; flex-direction: column; gap: 6px;")}>
          <div className="tn" style={st("display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: #6B6B6B;")}><span>Commission budget (cap)</span><span style={st("color: #333333;")}>{fmt2(c.budget.remaining)} of {fmt2(c.budget.total)} USDC left</span></div>
          <div aria-hidden="true" style={st("height: 3px; border-radius: 9999px; background: #F4F4F5; overflow: hidden;")}><div style={{ ...st("height: 100%; border-radius: 9999px;"), width: `${pct}%`, background: pct < 15 ? "#8A4B00" : "#0F766E" }} /></div>
        </div>
      </Link>
      <div className="tn" style={st("border-top: 1px solid #EBEBEB; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; color: #6B6B6B;")}>
        <span style={st("min-width: 0;")}>{[`${c.holdSecs} s hold`, refunds, `${c.sales.settled} ${c.sales.settled === 1 ? "sale" : "sales"}`].filter(Boolean).join(" · ")}</span>
        <Link className="tap" to={`/campaigns/${c.address}`} style={st("flex: none; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center;")}>View campaign →</Link>
      </div>
    </article>
  );
}

export default function Directory() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [sort, setSort] = useState("newest");
  const [activeOnly, setActiveOnly] = useState(false);
  const dq = useDebounced(q.trim(), 300);

  const params = new URLSearchParams({ sort, limit: "100" });
  if (cat) params.set("category", cat);
  if (dq) params.set("q", dq);
  if (activeOnly) params.set("status", "active");
  const list = useApi<ApiPage<Campaign>>("/campaigns?" + params.toString());
  const stats = useApi<Stats>("/stats");
  const fresh = useIndexFreshness();

  const items = list.data?.items ?? [];
  const filtered = !!(cat || dq || activeOnly);
  const clear = () => { setQ(""); setCat(null); setActiveOnly(false); };
  const vs = stats.data?.volumeBySource;
  const dec = stats.data?.decimals ?? 6;

  return (
    <Page>
      <TopNav cta />
      <main style={st("max-width: 1280px; margin: 0 auto; padding: 56px clamp(16px, 4vw, 48px) 80px; display: flex; flex-direction: column; gap: 32px;")}>
        <div style={st("display: flex; flex-wrap: wrap; gap: 24px; align-items: end; justify-content: space-between;")}>
          <div style={st("display: flex; flex-direction: column; gap: 10px; max-width: 640px;")}>
            <h1 style={st("font-size: clamp(2rem, 1.4rem + 2vw, 2.75rem); line-height: 1.05; letter-spacing: -0.03em; font-weight: 500; color: #111111;")}>Campaigns</h1>
            <p style={st("font-size: 16px; line-height: 24px; color: #333333;")}>Discover paid x402 services and earn commissions by bringing them paying customers. Every number is read from the chain.</p>
          </div>
          <Freshness ageSeconds={fresh.info?.ageSeconds} fetchedAt={fresh.fetchedAt} now={fresh.now} error={fresh.error} />
        </div>

        {/* Platform volume split: honest */}
        <section aria-label="Settled volume by source" style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); border: 1px solid #EBEBEB; border-radius: 12px; overflow: hidden;")}>
          <div style={st("padding: 12px 20px; display: flex; flex-direction: column; gap: 4px; border-right: 1px solid #EBEBEB;")}>
            <span style={st("font-size: 13px; font-weight: 500; color: #6B6B6B;")}>Listed campaigns</span>
            <span className="tn" style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.02em; font-weight: 500; color: #111111;")}>{stats.data ? stats.data.totals.listedCampaigns : "—"}</span>
          </div>
          <div style={st("padding: 12px 20px; display: flex; flex-direction: column; gap: 4px; border-right: 1px solid #EBEBEB;")}>
            <span style={st("font-size: 13px; font-weight: 500; color: #6B6B6B;")}>Settled volume · real services</span>
            <span className="tn" style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.02em; font-weight: 500; color: #111111;")}>
              {vs && vs.listed.settled > 0 ? <>{fmt2(vs.listed.volume, dec)} <span style={st("font-size: 14px; color: #6B6B6B; font-weight: 400;")}>USDC</span></> : "—"}
            </span>
          </div>
          <div style={st("padding: 12px 20px; display: flex; flex-direction: column; gap: 4px; background: #FAFAFA;")}>
            <span style={st("font-size: 13px; font-weight: 500; color: #6B6B6B; display: flex; align-items: center; gap: 8px;")}>Settled volume · <SampleBadge style={{ border: "1px solid #EBEBEB" }} /></span>
            <span className="tn" style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.02em; font-weight: 500; color: #111111;")}>
              {vs ? <>{fmt2(vs.sample.volume, dec)} <span style={st("font-size: 14px; color: #6B6B6B; font-weight: 400;")}>USDC</span></> : "—"}
            </span>
          </div>
        </section>

        {/* Toolbar */}
        <div style={st("display: flex; flex-direction: column; gap: 12px;")}>
          <div style={st("display: flex; flex-wrap: wrap; gap: 12px; align-items: center;")}>
            <div style={st("position: relative; flex: 1 1 320px;")}>
              <label htmlFor="q" className="vh">Search campaigns</label>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.5" aria-hidden="true" style={st("position: absolute; left: 12px; top: 12px;")}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input id="q" type="search" autoComplete="off" placeholder="Search services or merchants" value={q} onChange={(e) => setQ(e.target.value)}
                style={st("width: 100%; height: 40px; padding: 0 12px 0 36px; border: 1px solid #8A8A8A; border-radius: 8px; font: 400 14px Inter, sans-serif; color: #111111; background: #FFFFFF;")} />
            </div>
            <div style={st("display: flex; align-items: center; gap: 8px;")}>
              <label htmlFor="sort" style={st("font-size: 13px; color: #6B6B6B;")}>Sort</label>
              <div style={st("position: relative;")}>
                <select id="sort" value={sort} onChange={(e) => setSort(e.target.value)} style={st("height: 40px; padding: 0 36px 0 12px; border: 1px solid #8A8A8A; border-radius: 8px; font: 500 13px Inter, sans-serif; color: #111111; background: #FFFFFF; cursor: pointer;")}>
                  {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#333333" strokeWidth="1.5" aria-hidden="true" style={st("position: absolute; right: 12px; top: 13px; pointer-events: none;")}><path d="m6 9 6 6 6-6" /></svg>
              </div>
            </div>
          </div>
          <div role="group" aria-label="Category" style={st("display: flex; flex-wrap: wrap; gap: 8px;")}>
            {CAT_CHIPS.map(([label, value]) => {
              const on = cat === value;
              return (
                <button key={label} className="press chip" type="button" aria-pressed={on} onClick={() => setCat(value)}
                  style={st("height: 28px; padding: 0 12px; border-radius: 9999px; font: 500 13px Inter, sans-serif; cursor: pointer; " + (on ? "background: #111111; color: #FFFFFF; border: 1px solid #111111;" : "background: #FFFFFF; color: #333333; border: 1px solid #EBEBEB;"))}>{label}</button>
              );
            })}
          </div>
          <label style={st("display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #333333; cursor: pointer; height: 28px;")}>
              <input type="checkbox" checked={activeOnly} onChange={() => setActiveOnly((v) => !v)} style={st("width: 16px; height: 16px; accent-color: #0F766E; margin: 0;")} />
              Only campaigns with commission budget remaining
            </label>
        </div>

        <div style={st("display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: #6B6B6B;")} role="status">
          <span className="tn">{list.data ? `${items.length} of ${list.data.total} campaigns` : ""}</span>
        </div>

        {list.loading && (list.waking ? <><WakingBanner /><SkeletonCards /></> : <SkeletonCards />)}
        {list.error && <ErrorState title="Couldn’t load campaigns" onRetry={list.retry} />}
        {list.data && items.length > 0 && (
          <div style={st("display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 16px;")}>
            {items.map((c) => <CampaignCard key={c.address} c={c} />)}
          </div>
        )}
        {list.data && items.length === 0 && (
          <div style={st("display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; padding: 72px 24px; border: 1px dashed #D4D4D8; border-radius: 12px;")}>
            <div style={st("width: 44px; height: 44px; border-radius: 12px; background: #F4F4F5; display: flex; align-items: center; justify-content: center;")}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#333333" strokeWidth="1.5" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg></div>
            <h2 style={st("font-size: 16px; font-weight: 500; color: #111111;")}>{filtered ? "No campaigns match" : "No campaigns are listed yet"}</h2>
            <p style={st("font-size: 14px; color: #6B6B6B; max-width: 380px;")}>{filtered ? "Try another category or clear your search. Selling a paid endpoint yourself? List it here." : "Selling a paid endpoint? Be the first to list it here."}</p>
            {filtered && <button className="press bs" type="button" onClick={clear} style={st("height: 32px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;")}>Clear filters</button>}
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
