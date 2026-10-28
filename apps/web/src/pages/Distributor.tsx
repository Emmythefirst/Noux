import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { st } from "../lib/css";
import { ApiError, useApi, useCopy, useNow, type Campaign, type DistributorInfo, type Page as ApiPage, type Receipt } from "../lib/api";
import { bpsPct, dayTime, fmt2, fmtAmount, mmss, short } from "../lib/format";
import { isPubkey, useWalletAddress } from "../lib/wallet";
import { referralLink } from "../lib/buy";
import { useWallet } from "../lib/wallet-connect";
import { ViewingBar, WalletForm } from "../components/appshell";
import { isUnderpaid, ErrorState, Page, SampleBadge, TopNav, WakingBanner } from "../components/common";

const H2 = "font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;";
const SAMPLE_DISTRIBUTOR = "A84GL1aExB8hVTdVHYs5P4wgSaj5tnxZMPoqwdBUZxUo"; // the Noux demo buyer-agent's distributor wallet
const DAYS = 14;

function dailyEarned(sales: Receipt[], nowMs: number) {
  const day = 86400_000, today = Math.floor(nowMs / day) * day;
  const v = Array.from({ length: DAYS }, () => 0n);
  for (const s of sales) {
    if (s.status !== "settled" || !s.settledAt) continue;
    const idx = DAYS - 1 - Math.floor((today - Math.floor(new Date(s.settledAt).getTime() / day) * day) / day);
    if (idx >= 0 && idx < DAYS) v[idx] += BigInt(s.split.distributor);
  }
  return { v, labels: v.map((_, i) => new Date(today - (DAYS - 1 - i) * day)) };
}
const mon = (d: Date) => d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) + " " + d.getUTCDate();
const expected = (r: Receipt) => ((BigInt(r.vaultAmount === "0" ? r.price : r.vaultAmount) * BigInt(r.policy.commissionBps)) / 10000n).toString();

export default function Distributor() {
  const [sp, setSp] = useSearchParams();
  const [saved, setSaved] = useWalletAddress();
  const cw = useWallet();
  const { hash } = useLocation();
  const q = sp.get("wallet") ?? "";
  const wallet = isPubkey(q) ? q : (cw.address ?? "");
  const [changing, setChanging] = useState(false);
  const pick = (a: string) => { setSaved(a); setSp({ wallet: a }); setChanging(false); };
  const change = () => setChanging(true);
  const back = () => { setSp({}); setChanging(false); }; // drop the pasted address: fall back to the connected wallet (or the empty form)

  const d = useApi<DistributorInfo>(wallet ? `/distributors/${wallet}` : null);
  const all = useApi<ApiPage<Campaign>>(wallet ? "/campaigns?includeUnlisted=1&limit=100" : null);
  const now = useNow(1000);
  const [fmtTab, setFmtTab] = useState<"people" | "agents">("people");
  const [campSel, setCampSel] = useState("");
  const [copied, copy] = useCopy();
  const info = d.data;
  const chart = useMemo(() => dailyEarned(info?.recent ?? [], Date.now()), [info]);
  const camps = new Map((all.data?.items ?? []).map((c) => [c.address, c]));

  const body = (() => {
    if (!wallet || changing) return (
      <>
        <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
          <h1 style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>Earnings</h1>
          <p style={st("font-size: 14px; color: #6B6B6B;")}>Commission from buyers you referred, read from the chain.</p>
        </div>
        <WalletForm initial={saved} onSubmit={pick} onBack={wallet ? () => setChanging(false) : undefined} label="Which wallet are you earning to?" onCancel={wallet ? (cw.address ? back : () => setChanging(false)) : undefined} cancelLabel={cw.address ? "Use my connected wallet" : "Cancel"} example={{ label: "See the sample distributor", address: SAMPLE_DISTRIBUTOR }} />
      </>
    );
    if (d.loading) return d.waking ? <WakingBanner /> : <p role="status" style={st("font-size: 14px; color: #6B6B6B;")}>Loading earnings…</p>;
    if (d.error || !info) return <ErrorState title={d.error instanceof ApiError && d.error.status === 400 ? "That isn’t a valid address" : "Couldn’t load earnings"} onRetry={d.retry} />;

    const m = info.metrics;
    const recent = info.recent;
    const heldSales = recent.filter((r) => r.status === "open" && r.funded && !isUnderpaid(r)); // an underpaid sale will never settle, so it is not "pending"
    const heldTotal = heldSales.reduce((a, r) => a + BigInt(expected(r)), 0n);
    const next = heldSales.map((r) => (r.holdUntil ? new Date(r.holdUntil).getTime() : 0)).filter(Boolean).sort((a, b) => a - b)[0];
    const leftSecs = next ? (next - now) / 1000 : 0;
    const holdSecs = heldSales[0]?.policy.holdSecs ?? 0;
    const frac = holdSecs > 0 && next ? Math.min(1, Math.max(0, 1 - leftSecs / holdSecs)) : 1;
    const max = chart.v.reduce((a, b) => (b > a ? b : a), 0n);
    const shareList = [...camps.values()].filter((c) => c.listing).concat([...camps.values()].filter((c) => !c.listing).slice(0, 0));
    const sel = campSel || shareList[0]?.address || "";
    const selC = camps.get(sel);
    const slug = (selC?.listing?.name ?? "campaign").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const link = sel ? referralLink(sel, wallet) : "";
    const heldByCamp = new Map<string, number>();
    heldSales.forEach((r) => heldByCamp.set(r.campaign, (heldByCamp.get(r.campaign) ?? 0) + 1));
    const closed = m.eligiblePurchases + m.refunded;

    return (
      <>
        <div style={st("display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between;")}>
          <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
            <h1 style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>Earnings</h1>
            <p style={st("font-size: 14px; color: #6B6B6B;")}>Commission from buyers you referred, read from the chain.</p>
          </div>
          <a className="press bp" href="#links" style={st("height: 32px; padding: 0 12px; border-radius: 10px; background: #0F766E; color: #FFFFFF; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px;")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>Get referral link
          </a>
        </div>
        <ViewingBar address={wallet} onChange={change} connected={cw.address} />

        <section aria-label="Earnings summary" style={st("display: flex; flex-wrap: wrap; gap: 12px;")}>
          <div style={st("flex: 2 1 380px; border: 1px solid #EBEBEB; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 16px;")}>
            <div style={st("display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;")}>
              <div style={st("display: flex; flex-direction: column; gap: 6px;")}>
                <span style={st("font-size: 13px; color: #6B6B6B;")}>Paid to your wallet</span>
                <span className="tn" style={st("font-size: 44px; line-height: 46px; letter-spacing: -0.03em; font-weight: 500; color: #111111;")}>{fmtAmount(m.totalEarned, info.decimals)} <span style={st("font-size: 16px; color: #6B6B6B; font-weight: 400; letter-spacing: 0;")}>USDC</span></span>
                <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>{m.eligiblePurchases} settled sales across {m.campaigns} campaign{m.campaigns === 1 ? "" : "s"}</span>
              </div>
              {heldSales.length > 0 && (
                <div style={st("display: flex; flex-direction: column; gap: 6px; align-items: flex-start; padding: 12px 14px; background: #F0FDFA; border-radius: 12px; height: fit-content;")}>
                  <span style={st("font-size: 12px; color: #115E59; font-weight: 500;")}>{leftSecs > 0 ? "Held · settles soon" : "Held · ready to settle"}</span>
                  <div style={st("display: flex; align-items: center; gap: 10px;")}>
                    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" style={st("transform: rotate(-90deg);")}><circle cx="11" cy="11" r="9" fill="none" stroke="#CCEBE7" strokeWidth="2.5" /><circle cx="11" cy="11" r="9" fill="none" stroke="#0F766E" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="56.5" strokeDashoffset={56.5 * (1 - frac)} /></svg>
                    <span className="tn" style={st("font-size: 18px; font-weight: 500; color: #111111;")}>+{fmtAmount(heldTotal, info.decimals)} <span style={st("font-size: 12px; color: #6B6B6B; font-weight: 400;")}>{leftSecs > 0 ? `in ${mmss(leftSecs)}` : "any moment"}{heldSales.length > 1 ? ` · ${heldSales.length} sales` : ""}</span></span>
                  </div>
                  <span style={st("font-size: 11px; color: #6B6B6B;")}>Up to this amount, if the budget allows</span>
                </div>
              )}
            </div>
            <div role="img" aria-label="Commission settled per day over 14 days" style={st("position: relative; height: 120px;")}>
              <div aria-hidden="true" style={st("position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between;")}><div style={st("border-top: 1px dashed #EBEBEB;")} /><div style={st("border-top: 1px dashed #EBEBEB;")} /><div style={st("border-top: 1px solid #D4D4D8;")} /></div>
              <div style={st("position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 6px;")}>
                {chart.v.map((n, i) => (
                  <div key={i} title={`${mon(chart.labels[i])}: ${fmtAmount(n, info.decimals)} USDC`} style={st("flex: 1; height: 100%; display: flex; align-items: flex-end;")}>
                    <div className="grow bar-d" style={{ ...st("width: 100%; border-radius: 4px 4px 1px 1px;"), height: n === 0n ? "2px" : `${Number((n * 100n) / max)}%`, background: n === 0n ? "#EBEBEB" : "#0F766E", animationDelay: `${i * 30}ms` }} />
                  </div>
                ))}
              </div>
            </div>
            <div className="tn" style={st("display: flex; justify-content: space-between; font-size: 11px; color: #6B6B6B;")}><span>{mon(chart.labels[0])}</span><span>{mon(chart.labels[6])}</span><span>{mon(chart.labels[DAYS - 1])}</span></div>
            <span style={st("font-size: 11px; color: #6B6B6B;")}>Chart uses your latest {recent.length} sales (UTC days).</span>
          </div>
          <div style={st("flex: 1 1 240px; display: grid; grid-template-rows: repeat(3, auto); gap: 12px;")}>
            {[
              info.claims ? ["Claims issued → paid", `${info.claims.issued} → ${info.claims.paid}`, info.claims.issued === 0 ? "No claims on record for this address" : info.claims.paid > info.claims.issued ? "More payments than claims on record: some predate this record" : `${Math.round((info.claims.paid / info.claims.issued) * 100)}% of claims ended in a payment`] : ["Open sales", String(m.open), "Held, or waiting to be settled"],
              ["Distinct buyers", String(m.distinctBuyers), "Wallets that paid through you"],
              ["Refunded sales", String(m.refunded), closed ? `${((m.refunded / closed) * 100).toFixed(1)}% of your closed sales` : "No closed sales yet"],
            ].map(([k, v, n]) => (
              <div key={k} style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 4px;")}>
                <span style={st("font-size: 13px; color: #6B6B6B;")}>{k}</span>
                <span className="tn" style={st("font-size: 24px; line-height: 30px; letter-spacing: -0.02em; font-weight: 500; color: #111111;")}>{v}</span>
                <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>{n}</span>
              </div>
            ))}
          </div>
        </section>

        <div role="note" style={st("display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; border: 1px solid #EBEBEB; border-radius: 12px; font-size: 13px; line-height: 20px; color: #333333;")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="1.5" aria-hidden="true" style={st("flex: none; margin-top: 1px;")}><path d="M20 6 9 17l-5-5" /></svg>
          <span><span style={st("font-weight: 500; color: #111111;")}>Nothing to withdraw.</span> Commission lands in <span className="mono" style={st("font-size: 12px;")}>{short(wallet)}</span> in the same transaction that settles each sale. Noux never holds your earnings.</span>
        </div>

        <section id="links" aria-labelledby="l-h" style={st("border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px -1px rgb(0 0 0 / .06), 0 2px 4px 0 rgb(0 0 0 / .04);")}>
          <div style={st("display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center;")}>
            <h2 id="l-h" style={st(H2)}>Share a campaign</h2>
            <div role="tablist" aria-label="Referral format" style={st("display: flex; gap: 4px; padding: 3px; background: #F4F4F5; border-radius: 10px;")}>
              {([["people", "Link for people"], ["agents", "For agents"]] as const).map(([id, label]) => {
                const on = fmtTab === id;
                return <button key={id} className="press" type="button" role="tab" aria-selected={on} onClick={() => setFmtTab(id)} style={st("height: 30px; padding: 0 12px; border: 0; border-radius: 8px; font: 500 13px Inter, sans-serif; cursor: pointer; " + (on ? "background: #FFFFFF; color: #111111; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .06);" : "background: transparent; color: #6B6B6B;"))}>{label}</button>;
              })}
            </div>
          </div>
          {shareList.length === 0 ? <p style={st("font-size: 13px; color: #6B6B6B;")}>No listed campaigns to share yet.</p> : (
            <div style={st("display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end;")}>
              <div style={st("flex: 1 1 220px; display: flex; flex-direction: column; gap: 8px;")}>
                <label htmlFor="camp" style={st("font-size: 13px; font-weight: 500; color: #333333;")}>Campaign</label>
                <select id="camp" value={sel} onChange={(e) => setCampSel(e.target.value)} style={st("height: 40px; padding: 0 12px; border: 1px solid #8A8A8A; border-radius: 8px; font: 400 14px Inter, sans-serif; color: #111111; background: #FFFFFF;")}>
                  {shareList.map((c) => <option key={c.address} value={c.address}>{c.listing?.name} · {bpsPct(c.commissionBps, 0)}</option>)}
                </select>
              </div>
              {fmtTab === "people" ? (
                <div className="fadein" style={st("flex: 3 1 360px; display: flex; flex-direction: column; gap: 8px;")}>
                  <label htmlFor="lnk" style={st("font-size: 13px; font-weight: 500; color: #333333;")}>Your link</label>
                  <div style={st("display: flex; gap: 8px;")}>
                    <input id="lnk" className="mono" readOnly value={link} style={st("flex: 1; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid #8A8A8A; border-radius: 8px; font-size: 12px; color: #111111; background: #FAFAFA;")} />
                    <button className="press bp" type="button" onClick={() => copy("l", link)} style={st("height: 40px; padding: 0 14px; border: 0; background: #0F766E; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #FFFFFF; cursor: pointer; min-width: 92px;")}>{copied === "l" ? "Copied" : "Copy link"}</button>
                  </div>
                  <span style={st("font-size: 12px; color: #6B6B6B;")}>Anyone who opens it can pay with a wallet and you are credited as the referrer. <a href={link} target="_blank" rel="noreferrer">Open the link ↗</a></span>
                </div>
              ) : (
                <div className="fadein" style={st("flex: 3 1 360px; display: flex; flex-direction: column; gap: 8px;")}>
                  <span style={st("font-size: 13px; font-weight: 500; color: #333333;")}>Outline of the steps (the buyer signs the request)</span>
                  <pre className="mono" style={st("margin: 0; padding: 10px 12px; background: #FAFAFA; border: 1px solid #EBEBEB; border-radius: 8px; font-size: 12px; line-height: 18px; color: #333333; overflow-x: auto;")}>{`POST https://noux-api.onrender.com/v1/claims
{ "campaign": "${short(sel)}", "distributor": "${short(wallet)}",
  "buyer": "…", "price": "…", "ts": …, "buyerSignature": "…" }`}</pre>
                </div>
              )}
            </div>
          )}
          <p style={st("font-size: 12px; color: #6B6B6B;")}>Distributors earn a commission on this campaign. When you recommend it, say that you’re paid if someone buys.</p>
        </section>

        <section id="campaigns" aria-labelledby="c-h" style={st("display: flex; flex-direction: column; gap: 12px;")}>
          <h2 id="c-h" style={st(H2)}>Campaigns you promote</h2>
          {info.byCampaign.length === 0 ? <p style={st("font-size: 13px; color: #6B6B6B;")}>No sales through this address yet.</p> : (
            <div style={st("border: 1px solid #EBEBEB; border-radius: 12px; overflow-x: auto;")}>
              <table style={st("width: 100%; min-width: 720px; border-collapse: collapse; font-size: 14px;")}>
                <thead><tr style={st("height: 40px; text-align: left;")}>
                  {[["Campaign", "padding: 0 12px 0 16px;"], ["Commission", "padding: 0 12px; text-align: right;"], ["Budget left", "padding: 0 12px;"], ["Your sales", "padding: 0 12px; text-align: right;"], ["Earned", "padding: 0 16px 0 12px; text-align: right;"]].map(([h, s]) => <th key={h} scope="col" style={st("font-size: 12px; font-weight: 500; color: #6B6B6B; border-bottom: 1px solid #EBEBEB; " + s)}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {info.byCampaign.map((b) => {
                    const c = camps.get(b.campaign);
                    const tot = c ? BigInt(c.budget.total) : 0n;
                    const pctLeft = c && tot > 0n ? Number((BigInt(c.budget.remaining) * 1000n) / tot) / 10 : 0;
                    const held = heldByCamp.get(b.campaign);
                    return (
                      <tr key={b.campaign} className="rh" style={st("height: 52px;")}>
                        <td style={st("padding: 0 12px 0 16px; border-bottom: 1px solid #EBEBEB;")}><Link to={`/campaigns/${b.campaign}`} style={st("color: #111111; font-weight: 500;")}>{c?.listing?.name ?? <span className="mono" style={st("font-size: 12px;")}>{short(b.campaign)}</span>}</Link>{c?.listing?.isSample && <SampleBadge style={{ marginLeft: 6 }} />}</td>
                        <td className="tn" style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB; text-align: right; color: #0F766E; font-weight: 500;")}>{c ? bpsPct(c.commissionBps, 0) : "—"}</td>
                        <td style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB;")}>{c ? <div style={st("display: flex; align-items: center; gap: 10px;")}><div aria-hidden="true" style={st("width: 80px; height: 4px; background: #F4F4F5; border-radius: 9999px; overflow: hidden;")}><div style={{ width: `${pctLeft}%`, height: "100%", background: "#0F766E" }} /></div><span className="tn" style={st("font-size: 13px; color: #333333;")}>{fmt2(c.budget.remaining)} USDC</span></div> : "—"}</td>
                        <td className="tn" style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB; text-align: right; color: #111111;")}>{b.purchases}{held ? <span style={st("color: #6B6B6B;")}> +{held} held</span> : null}</td>
                        <td className="tn" style={st("padding: 0 16px 0 12px; border-bottom: 1px solid #EBEBEB; text-align: right; color: #111111; font-weight: 500;")}>{fmtAmount(b.earned, info.decimals)}</td>
                      </tr>
                    );
                  })}
                  <tr style={st("height: 44px; background: #FAFAFA;")}>
                    <td colSpan={3} style={st("padding: 0 12px 0 16px; font-size: 13px; color: #6B6B6B;")}>Total{info.byCampaign.length < m.campaigns ? ` (top ${info.byCampaign.length} of ${m.campaigns} campaigns)` : ""}</td>
                    <td className="tn" style={st("padding: 0 12px; text-align: right; color: #111111;")}>{m.eligiblePurchases}</td>
                    <td className="tn" style={st("padding: 0 16px 0 12px; text-align: right; color: #111111; font-weight: 500;")}>{fmtAmount(m.totalEarned, info.decimals)} <span style={st("color: #6B6B6B; font-weight: 400;")}>USDC</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section id="activity" aria-labelledby="a-h" style={st("display: flex; flex-direction: column; gap: 12px;")}>
          <h2 id="a-h" style={st(H2)}>Recent activity</h2>
          {recent.length === 0 ? <p style={st("font-size: 13px; color: #6B6B6B;")}>Nothing yet.</p> : (
            <ol style={st("list-style: none; margin: 0; padding: 0; border: 1px solid #EBEBEB; border-radius: 12px;")}>
              {recent.slice(0, 8).map((r) => {
                const s = r.status;
                const icon = s === "settled" ? ["M20 6 9 17l-5-5", "#0E7A2F", "#CAFACE"] : s === "open" ? ["M12 7v5l3 2", "#0058B0", "#E6F0FF"] : ["M18 6 6 18M6 6l12 12", "#6B6B6B", "#F4F4F5"];
                const left = s === "open" && r.holdUntil ? (new Date(r.holdUntil).getTime() - now) / 1000 : 0;
                const nm = camps.get(r.campaign)?.listing?.name ?? short(r.campaign);
                const title = s === "settled" ? `${nm} sale settled` : s === "open" ? (!r.funded ? `${nm} sale awaiting payment` : isUnderpaid(r) ? `${nm} sale underpaid: it can’t settle` : `${nm} sale held · ${left > 0 ? "settles in " + mmss(left) : "ready to settle"}`) : `${nm} sale refunded`;
                return (
                  <li key={r.sale} className="rh" style={st("display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid #EBEBEB;")}>
                    <span aria-hidden="true" style={{ ...st("width: 28px; height: 28px; border-radius: 9999px; display: flex; align-items: center; justify-content: center;"), background: icon[2] }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={icon[1]} strokeWidth="2"><path d={icon[0]} /></svg></span>
                    <div style={st("display: flex; flex-direction: column; gap: 2px; min-width: 0;")}><span style={st("font-size: 14px; color: #111111;")}>{title}</span><span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>Receipt <Link to={`/r/${r.sale}`} className="mono">{short(r.sale)}</Link> · Buyer {short(r.parties.buyer)} · {dayTime(r.settledAt ?? r.openedAt)}</span></div>
                    <span className="tn" style={st("font-size: 14px; font-weight: 500; text-align: right; color: " + (s === "settled" ? "#0F766E;" : "#6B6B6B;"))}>{s === "refunded" ? "—" : "+" + fmtAmount(s === "settled" ? r.split.distributor : expected(r), r.decimals)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </>
    );
  })();

  // the earnings sections only exist once the data has loaded, so jump to an #anchor (Referral links, Receipts) after that
  useEffect(() => { if (hash && info) requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" })); }, [hash, info]);

  return (
    <Page>
      <TopNav />
      <main style={st("max-width: 1240px; margin: 0 auto; padding: 32px clamp(16px, 4vw, 48px) 80px; display: flex; flex-direction: column; gap: 24px;")}>{body}</main>
    </Page>
  );
}
