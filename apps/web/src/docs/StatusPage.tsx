import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { st } from "../lib/css";
import { explorerAddr, useApi, useNow, type IndexInfo, type Stats } from "../lib/api";
import { short } from "../lib/format";
import { Dot } from "../components/common";

const DEMO = "https://noux-demo-merchant.onrender.com/healthz";

type Probe = { state: "checking" | "up" | "down"; ms?: number };
function useProbe(url: string): Probe {
  const [p, setP] = useState<Probe>({ state: "checking" });
  useEffect(() => {
    let live = true; const t0 = Date.now(); const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 65_000);
    fetch(url, { signal: ctl.signal, cache: "no-store" }).then((r) => { if (live) setP(r.ok ? { state: "up", ms: Date.now() - t0 } : { state: "down" }); }).catch(() => { if (live) setP({ state: "down" }); }).finally(() => clearTimeout(to));
    return () => { live = false; ctl.abort(); clearTimeout(to); };
  }, [url]);
  return p;
}

const ROW = "display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid #EBEBEB; font-size: 14px;";

export default function StatusPage() {
  const idx = useApi<IndexInfo>("/index");
  const stats = useApi<Stats>("/stats");
  const demo = useProbe(DEMO);
  const now = useNow(1000);
  const [t0] = useState(Date.now());
  const age = idx.data?.ageSeconds != null ? idx.data.ageSeconds + Math.floor((now - t0) / 1000) : null;
  const apiState = idx.loading ? "checking" : idx.data ? "up" : "down";
  const dot = (s: string) => <Dot color={s === "up" ? "#15B042" : s === "down" ? "#D92D20" : "#8A8A8A"} />;
  const label = (s: string, ms?: number) => (s === "up" ? `Up${ms ? ` · ${(ms / 1000).toFixed(1)} s` : ""}` : s === "down" ? "Not answering" : "Checking…");
  const p = stats.data?.protocol;
  return (
    <div style={st("display: flex; flex-direction: column; gap: 24px; font-size: 16px; line-height: 26px;")}>
      <p style={st("font-size: 18px; line-height: 28px; color: #333333; text-wrap: pretty;")}>Live checks of the devnet services, run from your browser right now.</p>
      <div role="note" style={st("padding: 14px 16px; border: 1px solid #EBEBEB; border-radius: 12px; font-size: 14px; line-height: 22px; color: #333333;")}>The free servers sleep after 15 minutes without traffic and can take up to a minute to wake. A slow first answer is normal, not an outage.</div>
      <section aria-label="Services" style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 4px 20px;")}>
        <div style={st(ROW)}><span style={st("display: flex; align-items: center; gap: 8px; color: #111111;")}>{dot(apiState)}Read API <span className="mono" style={st("font-size: 12px; color: #6B6B6B;")}>noux-api.onrender.com</span></span><span style={st("color: #6B6B6B;")}>{label(apiState)}</span></div>
        <div style={st(ROW)}><span style={st("display: flex; align-items: center; gap: 8px; color: #111111;")}>{dot(idx.data ? (age !== null && age > 180 ? "down" : "up") : apiState)}Indexer</span><span className="tn" style={st("color: #6B6B6B;")}>{age === null ? "—" : age > 180 ? `Behind: last synced ${age} s ago` : `Synced ${age} s ago`}</span></div>
        <div style={st(ROW)}><span style={st("display: flex; align-items: center; gap: 8px; color: #111111;")}>{dot(demo.state)}Sample merchant <span className="mono" style={st("font-size: 12px; color: #6B6B6B;")}>noux-demo-merchant.onrender.com</span></span><span style={st("color: #6B6B6B;")}>{label(demo.state, demo.ms)}</span></div>
        <div style={st(ROW.replace("border-bottom: 1px solid #EBEBEB;", ""))}><span style={st("display: flex; align-items: center; gap: 8px; color: #111111;")}>{dot(idx.data ? (idx.data.lastError ? "down" : "up") : apiState)}Last indexer error</span><span style={st("color: #6B6B6B; text-align: right;")}>{idx.data ? (idx.data.lastError ?? "none") : "—"}</span></div>
      </section>
      <section aria-label="Network" style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 4px 20px;")}>
        {[
          ["Cluster", stats.data?.cluster === "devnet" ? "Solana devnet (test money)" : stats.data?.cluster ?? "—"],
          ["Program", stats.data ? <a className="mono" href={explorerAddr(stats.data.programId)} target="_blank" rel="noreferrer" style={st("font-size: 12px;")}>{short(stats.data.programId, 6, 6)} ↗</a> : "—"],
          ["Campaigns · sales indexed", idx.data ? `${idx.data.campaigns} · ${idx.data.sales}` : "—"],
          ["Protocol fee (on-chain config)", p ? `${(p.feeBps / 100).toFixed(2)}% (max ${(p.maxFeeBps / 100).toFixed(0)}%)` : "—"],
          ["Fee wallet", p ? <a className="mono" href={explorerAddr(p.feeOwner)} target="_blank" rel="noreferrer" style={st("font-size: 12px;")}>{short(p.feeOwner)} ↗</a> : "—"],
          ["Config admin", p ? <a className="mono" href={explorerAddr(p.admin)} target="_blank" rel="noreferrer" style={st("font-size: 12px;")}>{short(p.admin)} ↗</a> : "—"],
        ].map(([k, v], i, a) => <div key={k as string} style={st(ROW + (i === a.length - 1 ? " border-bottom: 0;" : ""))}><span style={st("color: #6B6B6B;")}>{k}</span><span style={st("color: #111111;")}>{v}</span></div>)}
      </section>
      <p style={st("font-size: 13px; line-height: 20px; color: #6B6B6B;")}>The sample merchant also exposes sanitised operator diagnostics at <span className="mono">/v1/status</span>. See the <Link to="/docs/security-model">Security model</Link> for what is and is not protected.</p>
    </div>
  );
}
