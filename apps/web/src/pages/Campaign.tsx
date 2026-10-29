import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { st } from "../lib/css";
import { ApiError, explorerAddr, useApi, useCopy, useIndexFreshness, useNow, type CampaignDetail, type Page as ApiPage, type Receipt } from "../lib/api";
import { CATEGORIES, bpsPct, dateOnly, dayTime, fmt2, fmtAmount, fmtShort, initials, mmss, short } from "../lib/format";
import { isPubkey, useWalletAddress } from "../lib/wallet";
import { referralLink } from "../lib/buy";
import { useWallet } from "../lib/wallet-connect";
import { ListingModal } from "../components/listing-modal";
import { RotateKeyDialog, TopUpDialog } from "../components/campaign-controls";
import { Addr, isUnderpaid, openText, Disclosure, Dot, ErrorState, Page, SaleBadge, SampleBadge, TopNav, WakingBanner } from "../components/common";

const H2 = "font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;";
const RING = "box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 1px -.5px rgb(0 0 0 / .06), 0 3px 3px -1.5px rgb(0 0 0 / .06), 0 6px 6px -3px rgb(0 0 0 / .06), 0 12px 12px -6px rgb(0 0 0 / .06);";
const DAYS = 14;

/** Settled sales per UTC day over the last 14 days, from the receipts we have. */
function dailyCounts(sales: Receipt[], nowMs: number) {
  const day = 86400_000;
  const today = Math.floor(nowMs / day) * day;
  const counts = Array.from({ length: DAYS }, () => 0);
  for (const s of sales) {
    if (s.status !== "settled" || !s.settledAt) continue;
    const idx = DAYS - 1 - Math.floor((today - Math.floor(new Date(s.settledAt).getTime() / day) * day) / day);
    if (idx >= 0 && idx < DAYS) counts[idx]++;
  }
  const labels = counts.map((_, i) => new Date(today - (DAYS - 1 - i) * day));
  return { counts, labels };
}
const mon = (d: Date) => d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) + " " + d.getUTCDate();

function Promote({ c }: { c: CampaignDetail }) {
  const [tab, setTab] = useState<"people" | "agents">("people");
  const [saved, setWallet] = useWalletAddress();
  const cw = useWallet();
  const wallet = saved || cw.address || "";
  const [copied, copy] = useCopy();
  const ok = isPubkey(wallet);
  const slug = (c.listing?.name ?? "campaign").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const link = ok ? referralLink(c.address, wallet) : "Paste your wallet address above";
  return (
    <section id="promote" aria-labelledby="p-h" style={st("border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 16px; " + RING)}>
      <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
        <h2 id="p-h" style={st(H2)}>Promote this campaign</h2>
        <p style={st("font-size: 13px; line-height: 18px; color: #6B6B6B;")}>Your wallet address is your referral ID. Nothing to sign up for.</p>
      </div>
      <div style={st("display: flex; flex-direction: column; gap: 6px;")}>
        <label htmlFor="wallet" style={st("font-size: 13px; font-weight: 500; color: #333333;")}>Your wallet address</label>
        <input id="wallet" className="mono" spellCheck={false} autoComplete="off" placeholder="Paste your Solana address" value={wallet} onChange={(e) => setWallet(e.target.value.trim())}
          aria-invalid={wallet !== "" && !ok}
          style={st("height: 40px; padding: 0 12px; border: 1px solid " + (wallet !== "" && !ok ? "#D92D20" : "#8A8A8A") + "; border-radius: 8px; font-size: 12px; color: #111111; background: #FFFFFF; width: 100%;")} />
        {wallet !== "" && !ok && <span style={st("font-size: 12px; color: #B42318;")}>That doesn’t look like a Solana address.</span>}
      </div>
      <div style={st("background: #F4F4F5; border-radius: 12px; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px;")}>
        <span style={st("font-size: 13px; color: #333333;")}>You earn per sale</span>
        <span className="tn" style={st("font-size: 18px; font-weight: 500; color: #0F766E; letter-spacing: -0.01em;")}>{bpsPct(c.commissionBps, c.commissionBps % 100 ? 2 : 0)} <span style={st("font-size: 12px; color: #6B6B6B; font-weight: 400;")}>of the price</span></span>
      </div>
      <div role="tablist" aria-label="Referral format" style={st("display: flex; gap: 4px; padding: 3px; background: #F4F4F5; border-radius: 10px;")}>
        {([["people", "For people"], ["agents", "For agents"]] as const).map(([id, label]) => {
          const on = tab === id;
          return <button key={id} className="press" type="button" role="tab" aria-selected={on} onClick={() => setTab(id)}
            style={st("flex: 1; height: 30px; border: 0; border-radius: 8px; font: 500 13px Inter, sans-serif; cursor: pointer; " + (on ? "background: #FFFFFF; color: #111111; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .06);" : "background: transparent; color: #6B6B6B;"))}>{label}</button>;
        })}
      </div>
      {tab === "people" && (
        <div className="fadein" style={st("display: flex; flex-direction: column; gap: 8px;")}>
          <label htmlFor="ref" style={st("font-size: 13px; font-weight: 500; color: #333333;")}>Referral link</label>
          <div style={st("display: flex; gap: 8px;")}>
            <input id="ref" className="mono" readOnly value={link} style={st("flex: 1; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid #8A8A8A; border-radius: 8px; font-size: 12px; color: #111111; background: #FFFFFF;")} />
            <button className="press bs" type="button" disabled={!ok} onClick={() => copy("ref", link)} style={{ ...st("height: 40px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer; min-width: 76px;"), opacity: ok ? 1 : 0.5 }}>{copied === "ref" ? "Copied" : "Copy"}</button>
          </div>
          <span style={st("font-size: 12px; color: #6B6B6B;")}>Anyone who opens it can pay for this service with a wallet. You are credited as the referrer and earn the commission when the sale settles. {ok && <a href={link} target="_blank" rel="noreferrer">Open the link ↗</a>}</span>
        </div>
      )}
      {tab === "agents" && (
        <div className="fadein" style={st("display: flex; flex-direction: column; gap: 8px;")}>
          <span style={st("font-size: 13px; font-weight: 500; color: #333333;")}>Outline of the steps</span>
          <pre className="mono" style={st("margin: 0; padding: 12px; background: #FAFAFA; border: 1px solid #EBEBEB; border-radius: 8px; font-size: 11px; line-height: 17px; color: #333333; overflow-x: auto;")}>{`POST /v1/claims   (signed by the buyer)
campaign:    ${short(c.address)}
distributor: ${ok ? short(wallet) : "<your-wallet>"}
buyer, price, ts, buyerSignature

GET ${c.listing?.route.replace(/^GET /, "") ?? "<route>"}
x-noux-claim: <claim>`}</pre>
          <span style={st("font-size: 12px; color: #6B6B6B;")}>This is an outline, not code to paste: the buyer’s request has to be signed with a wallet key.</span>
          <a href="https://github.com/Emmythefirst/Noux/blob/main/apps/api/scripts/demo-buy.ts" target="_blank" rel="noreferrer" style={st("font-size: 13px; font-weight: 500;")}>Run the working example ↗</a>
          <Link to="/docs/agents-and-claims" style={st("font-size: 13px; font-weight: 500;")}>Agent guide →</Link>
        </div>
      )}
      <p style={st("font-size: 12px; line-height: 17px; color: #6B6B6B; border-top: 1px solid #EBEBEB; padding-top: 12px;")}>Distributors earn a commission on this campaign. Tell your audience when you’re paid to recommend something.</p>
    </section>
  );
}

export default function CampaignPage() {
  const { address = "" } = useParams();
  const camp = useApi<CampaignDetail>(`/campaigns/${address}`);
  const sales = useApi<ApiPage<Receipt>>(`/campaigns/${address}/sales?limit=100`);
  const fresh = useIndexFreshness();
  const now = useNow(1000);
  const me = useWallet().address;
  const [listing, setListing] = useState(false);
  const [controls, setControls] = useState<null | "topup" | "key">(null);
  const [note, setNote] = useState<string | null>(null);
  const c = camp.data;
  const chart = useMemo(() => dailyCounts(sales.data?.items ?? [], Date.now()), [sales.data]);

  if (camp.loading) return <Page><TopNav /><main style={st("max-width: 1280px; margin: 0 auto; padding: 32px clamp(16px, 4vw, 48px);")}>{camp.waking ? <WakingBanner /> : <p role="status" style={st("font-size: 14px; color: #6B6B6B;")}>Loading campaign…</p>}</main></Page>;
  if (camp.error || !c) {
    const nf = camp.error instanceof ApiError && camp.error.status === 404;
    return <Page><TopNav /><main style={st("max-width: 1280px; margin: 0 auto; padding: 56px clamp(16px, 4vw, 48px);")}><ErrorState title={nf ? "Campaign not found" : "Couldn’t load this campaign"} body={nf ? "No campaign with that address is indexed. It may be new (the index runs about every 20 s) or the address is wrong." : undefined} onRetry={nf ? undefined : camp.retry} /></main></Page>;
  }

  const l = c.listing;
  const name = l?.name ?? "Unlisted campaign";
  const m = c.metrics;
  const total = BigInt(c.budget.total);
  const leftPct = total > 0n ? Number((BigInt(c.budget.remaining) * 1000n) / total) / 10 : 0;
  const closed = m.settled + m.refunded;
  const maxC = Math.max(2, ...chart.counts);
  const top = maxC % 2 ? maxC + 1 : maxC;
  const topBuyerSales = Math.round(m.topBuyerShare * m.settled);
  const items = sales.data?.items ?? [];
  const spent = c.status === "budget_exhausted";

  const metrics = [
    { label: "Settled sales", value: String(m.settled), unit: "", note: "Paid and split" },
    { label: "Refunded", value: String(m.refunded), unit: "", note: closed ? `${((m.refunded / closed) * 100).toFixed(1)}% of closed sales` : "No closed sales yet" },
    { label: "Open", value: String(m.open), unit: "", note: "In the hold window or awaiting settlement" },
    { label: "Settled volume", value: fmtShort(m.volume), unit: " USDC", note: "Gross paid by buyers" },
    { label: "Commissions paid", value: fmtShort(m.commissionsPaid), unit: " USDC", note: `To ${m.distinctDistributors} distributor${m.distinctDistributors === 1 ? "" : "s"}` },
    { label: "Protocol fees", value: fmtShort(m.protocolFees), unit: " USDC", note: `${bpsPct(c.feeBps, c.feeBps % 100 ? 2 : 0)} of volume` },
    { label: "Distinct buyers", value: String(m.distinctBuyers), unit: "", note: "Wallets that paid" },
    { label: "Distinct distributors", value: String(m.distinctDistributors), unit: "", note: "With a settled sale" },
    { label: "Top buyer share", value: m.settled ? String(Math.round(m.topBuyerShare * 100)) : "—", unit: m.settled ? "%" : "", note: m.settled ? `${topBuyerSales} of ${m.settled} sales, one wallet` : "No settled sales yet" },
  ];

  return (
    <Page>
      <TopNav />
      <main style={st("max-width: 1280px; margin: 0 auto; padding: 32px clamp(16px, 4vw, 48px) 80px; display: flex; flex-direction: column; gap: 32px;")}>
        <nav aria-label="Breadcrumb" style={st("font-size: 13px; color: #6B6B6B; display: flex; gap: 8px; align-items: center;")}><Link to="/campaigns" style={st("color: #6B6B6B;")}>Campaigns</Link><span aria-hidden="true">/</span><span style={st("color: #111111;")}>{name}</span></nav>

        <div style={st("display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; justify-content: space-between;")}>
          <div style={st("display: flex; gap: 16px; align-items: flex-start;")}>
            <div aria-hidden="true" style={st("width: 56px; height: 56px; flex: none; border-radius: 16px; background: #F4F4F5; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 600; color: #111111; letter-spacing: -0.02em;")}>{initials(name)}</div>
            <div style={st("display: flex; flex-direction: column; gap: 8px;")}>
              <div style={st("display: flex; align-items: center; gap: 10px; flex-wrap: wrap;")}>
                <h1 style={st("font-size: 32px; line-height: 36px; letter-spacing: -0.025em; font-weight: 500; color: #111111;")}>{name}</h1>
                {l?.isSample && <SampleBadge />}
                <span style={st("height: 20px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; " + (spent ? "background: #FFF1D6; color: #8A4B00;" : "background: #CAFACE; color: #0E7A2F;"))}><Dot color={spent ? "#8A4B00" : "#15B042"} />{spent ? "Budget spent" : "Active"}</span>
              </div>
              <p style={st("font-size: 14px; line-height: 20px; color: #333333; max-width: 560px;")}>{l ? l.description : "This campaign is unlisted: its merchant hasn’t published a listing, so it isn’t in the directory. Anyone with the link can still see it. Only promote it if you know and trust the merchant."}</p>
              <div style={st("display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: #6B6B6B; align-items: center;")}>
                {l && <span>Category <span style={st("color: #333333;")}>{CATEGORIES[l.category] ?? l.category}</span></span>}
                <span>Merchant <Addr value={c.merchant} copy style={{ color: "#333333" }} /></span>
                <span>Campaign <Addr value={c.address} copy style={{ color: "#333333" }} /></span>
                <a href={explorerAddr(c.address)} target="_blank" rel="noreferrer" style={st("font-size: 13px;")}>Open in explorer ↗</a>
              </div>
            </div>
          </div>
          <div style={st("display: flex; gap: 8px; flex-wrap: wrap;")}>
          {me && me === c.merchant && <button className="press bs" type="button" onClick={() => setListing(true)} style={st("height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid #D4D4D8; background: #FFFFFF; color: #111111; font: 500 14px Inter, sans-serif; cursor: pointer;")}>{c.listing ? "Edit listing" : "List this campaign"}</button>}
          {me && me === c.merchant && <button className="press bs" type="button" onClick={() => setControls("topup")} style={st("height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid #D4D4D8; background: #FFFFFF; color: #111111; font: 500 14px Inter, sans-serif; cursor: pointer;")}>Add budget</button>}
          {me && me === c.merchant && <button className="press bs" type="button" onClick={() => setControls("key")} style={st("height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid #D4D4D8; background: #FFFFFF; color: #111111; font: 500 14px Inter, sans-serif; cursor: pointer;")}>Change claim key</button>}
          {me && me === c.merchant && <Link className="press bs" to="/app/merchant" style={st("height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid #D4D4D8; background: #FFFFFF; color: #111111; font-size: 14px; font-weight: 500; display: inline-flex; align-items: center;")}>Manage in merchant console</Link>}
          <a className="press bp" href="#promote" style={st("height: 40px; padding: 0 16px; border-radius: 10px; background: #0F766E; color: #FFFFFF; font-size: 14px; font-weight: 500; display: inline-flex; align-items: center; gap: 8px;")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>Get referral link
          </a>
          </div>
        </div>

        {/* Terms */}
        <section aria-label="Campaign terms" style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); border: 1px solid #EBEBEB; border-radius: 12px;")}>
          {[
            ["Price per call", <>{l?.displayPrice ?? "—"}</>, "#111111"],
            ["Commission", <>{bpsPct(c.commissionBps, c.commissionBps % 100 ? 2 : 0)}</>, "#0F766E"],
            ["Protocol fee", <>{bpsPct(c.feeBps, c.feeBps % 100 ? 2 : 0)}</>, "#111111", c.feeEnforced === true ? "Set by the program" : c.feeEnforced === false ? "Set by this campaign (legacy)" : ""],
            ["Refund hold", <>{c.holdSecs} <span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>s</span></>, "#111111"],
            ["Claim lifetime", <>10 <span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>min</span></>, "#111111"],
          ].map(([k, v, color, cap]) => (
            <div key={k as string} style={st("padding: 16px 20px; display: flex; flex-direction: column; gap: 4px; border-right: 1px solid #EBEBEB;")}>
              <span style={st("font-size: 12px; color: #6B6B6B;")}>{k}</span>
              <span className="tn" style={{ ...st("font-size: 20px; letter-spacing: -0.015em; font-weight: 500;"), color: color as string }}>{v}</span>
              {cap ? <span style={st("font-size: 11px; color: #6B6B6B;")}>{cap as string}</span> : null}
            </div>
          ))}
          <div style={st("padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; grid-column: span 2; min-width: 0;")}>
            <div style={st("display: flex; justify-content: space-between; gap: 8px;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Commission budget left (cap)</span><span style={st("font-size: 12px; color: #6B6B6B;")}>Refund rate <span className="tn" style={st("color: #111111; font-weight: 500;")}>{c.sales.refundRate === null ? "—" : (c.sales.refundRate * 100).toFixed(1) + "%"}</span></span></div>
            <span className="tn" style={st("font-size: 20px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>{fmt2(c.budget.remaining)} <span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>of {fmt2(c.budget.total)} USDC</span></span>
            <div role="progressbar" aria-label="Commission budget left" aria-valuenow={leftPct} aria-valuemin={0} aria-valuemax={100} style={st("height: 4px; background: #F4F4F5; border-radius: 9999px; overflow: hidden;")}><div style={{ ...st("height: 100%; background: #0F766E; border-radius: 9999px;"), width: `${leftPct}%` }} /></div>
          </div>
        </section>

        <div style={st("display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start;")}>
          <div style={st("flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 32px;")}>
            <section aria-labelledby="m-h" style={st("display: flex; flex-direction: column; gap: 16px;")}>
              <div style={st("display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap;")}>
                <h2 id="m-h" style={st(H2)}>What this campaign has done</h2>
                <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>All time · {fresh.info?.ageSeconds != null ? `indexed ${fresh.info.ageSeconds + Math.max(0, Math.floor((fresh.now - fresh.fetchedAt) / 1000))} s ago` : "index age unknown"}</span>
              </div>
              <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 1px; background: #EBEBEB; border: 1px solid #EBEBEB; border-radius: 12px; overflow: hidden;")}>
                {metrics.map((x) => (
                  <div key={x.label} style={st("background: #FFFFFF; padding: 16px; display: flex; flex-direction: column; gap: 6px;")}>
                    <span style={st("font-size: 12px; color: #6B6B6B;")}>{x.label}</span>
                    <span className="tn" style={st("font-size: 24px; line-height: 30px; letter-spacing: -0.02em; font-weight: 500; color: #111111;")}>{x.value}<span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>{x.unit}</span></span>
                    <span style={st("font-size: 12px; color: #6B6B6B;")}>{x.note}</span>
                  </div>
                ))}
              </div>
              {l?.isSample && <p style={st("font-size: 12px; color: #6B6B6B; display: flex; align-items: center; gap: 8px;")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>Sample service: these sales came from the Noux team’s test wallets, not real customers.</p>}
            </section>

            <section aria-labelledby="c-h" style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 16px;")}>
              <div style={st("display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap;")}>
                <h2 id="c-h" style={st(H2)}>Settled sales per day</h2>
                <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>{mon(chart.labels[0])} – {mon(chart.labels[DAYS - 1])}, UTC{sales.data && sales.data.total > sales.data.items.length ? ` · latest ${sales.data.items.length} sales` : ""}</span>
              </div>
              <div role="img" aria-label={`Settled sales per day over 14 days, peak ${Math.max(...chart.counts)}`} style={st("display: grid; grid-template-columns: 24px 1fr; gap: 8px;")}>
                <div className="tn" style={st("display: flex; flex-direction: column; justify-content: space-between; height: 160px; font-size: 11px; color: #6B6B6B; text-align: right;")}><span>{top}</span><span>{top / 2}</span><span>0</span></div>
                <div style={st("position: relative; height: 160px;")}>
                  <div aria-hidden="true" style={st("position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between;")}><div style={st("border-top: 1px dashed #EBEBEB;")} /><div style={st("border-top: 1px dashed #EBEBEB;")} /><div style={st("border-top: 1px solid #D4D4D8;")} /></div>
                  <div style={st("position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 6px;")}>
                    {chart.counts.map((n, i) => (
                      <div key={i} title={`${mon(chart.labels[i])}: ${n} settled`} style={st("flex: 1; height: 100%; display: flex; align-items: flex-end;")}>
                        <div className="grow bar" style={{ ...st("width: 100%; border-radius: 4px 4px 1px 1px; transition: background-color 150ms;"), height: n === 0 ? "2px" : `${(n / top) * 100}%`, background: n === 0 ? "#EBEBEB" : "#111111", animationDelay: `${i * 30}ms` }} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="tn" style={st("display: grid; grid-template-columns: 24px 1fr; gap: 8px; font-size: 11px; color: #6B6B6B;")}><span /><div style={st("display: flex; justify-content: space-between;")}><span>{mon(chart.labels[0])}</span><span>{mon(chart.labels[6])}</span><span>{mon(chart.labels[DAYS - 1])}</span></div></div>
            </section>

            <section aria-labelledby="r-h" style={st("display: flex; flex-direction: column; gap: 12px;")}>
              <div style={st("display: flex; align-items: baseline; justify-content: space-between; gap: 12px;")}>
                <h2 id="r-h" style={st(H2)}>Recent receipts</h2>
              </div>
              <div style={st("border: 1px solid #EBEBEB; border-radius: 12px; overflow-x: auto;")}>
                <table style={st("width: 100%; min-width: 640px; border-collapse: collapse; font-size: 14px;")}>
                  <thead><tr style={st("height: 40px; text-align: left;")}>
                    {[["Sale", "padding: 0 12px 0 16px;"], ["Distributor", "padding: 0 12px;"], ["Status", "padding: 0 12px;"], ["Paid", "padding: 0 12px; text-align: right;"], ["Commission", "padding: 0 16px 0 12px; text-align: right;"]].map(([h, s]) => (
                      <th key={h} scope="col" style={st("font-size: 12px; font-weight: 500; color: #6B6B6B; border-bottom: 1px solid #EBEBEB; " + s)}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {items.slice(0, 6).map((r) => {
                      const left = r.status === "open" && r.holdUntil ? (new Date(r.holdUntil).getTime() - now) / 1000 : 0;
                      return (
                        <tr key={r.sale} className="rh" style={st("height: 40px;")}>
                          <td style={st("padding: 0 12px 0 16px; border-bottom: 1px solid #EBEBEB;")}><Link className="mono" to={`/r/${r.sale}`} style={st("font-size: 12px;")}>{short(r.sale)}</Link> <span className="tn" style={st("font-size: 12px; color: #6B6B6B; margin-left: 6px;")}>{dayTime(r.settledAt ?? r.openedAt)}</span></td>
                          <td className="mono" style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB; font-size: 12px; color: #333333;")}>{short(r.parties.distributor)}</td>
                          <td style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB;")}><SaleBadge status={r.status} warn={isUnderpaid(r)} text={r.status === "open" ? openText(r, left) : undefined} /></td>
                          <td className="tn" style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB; text-align: right; color: #111111;")}>{fmtAmount(r.status === "open" ? r.vaultAmount : r.gross, r.decimals)}</td>
                          <td className="tn" style={st("padding: 0 16px 0 12px; border-bottom: 1px solid #EBEBEB; text-align: right; color: #111111;")}>{r.status === "refunded" ? "—" : fmtAmount(r.split.distributor, r.decimals)}</td>
                        </tr>
                      );
                    })}
                    {sales.loading && <tr><td colSpan={5} style={st("padding: 20px 16px; font-size: 13px; color: #6B6B6B;")}>Loading receipts…</td></tr>}
                    {!sales.loading && items.length === 0 && <tr><td colSpan={5} style={st("padding: 20px 16px; font-size: 13px; color: #6B6B6B;")}>No sales yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <aside style={st("flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 16px;")}>
            <Promote c={c} />

            <section aria-labelledby="d-h" style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 12px;")}>
              <h2 id="d-h" style={st(H2)}>Top distributors</h2>
              {c.topDistributors.length === 0 ? <p style={st("font-size: 13px; color: #6B6B6B;")}>No distributor has a settled sale yet.</p> : (
                <ol style={st("list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;")}>
                  {c.topDistributors.slice(0, 5).map((d, i, a) => (
                    <li key={d.distributor} style={st("display: grid; grid-template-columns: 24px 1fr auto; gap: 10px; align-items: center; height: 44px; " + (i < a.length - 1 ? "border-bottom: 1px solid #EBEBEB;" : ""))}>
                      <span aria-hidden="true" style={{ ...st("width: 24px; height: 24px; border-radius: 9999px; color: #FFFFFF; font-size: 10px; font-weight: 600; display: flex; align-items: center; justify-content: center;"), background: i % 2 ? "#111111" : "#0F766E" }}>{d.distributor.slice(0, 2)}</span>
                      <Link className="mono" to={`/app/earnings?wallet=${d.distributor}`} style={st("font-size: 12px; color: #333333;")}>{short(d.distributor)}</Link>
                      <span className="tn" style={st("font-size: 13px; color: #111111;")}>{d.purchases} sale{d.purchases === 1 ? "" : "s"} · <span style={st("font-weight: 500;")}>{fmtShort(d.earned)}</span></span>
                    </li>
                  ))}
                </ol>
              )}
              <span style={st("font-size: 12px; color: #6B6B6B;")}>Commission in USDC. Ranked by commission earned, not an endorsement.</span>
            </section>

            <section aria-labelledby="l-h" style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 12px;")}>
              <h2 id="l-h" style={st(H2)}>Listing</h2>
              <dl style={st("margin: 0; display: flex; flex-direction: column; font-size: 13px;")}>
                {[
                  ["Endpoint", l ? <span className="mono" style={st("font-size: 12px; color: #333333; overflow-wrap: anywhere; text-align: right;")}>{l.endpointUrl.replace(/^https:\/\//, "")}</span> : "—"],
                  ["Signed by", l ? <span style={st("color: #0E7A2F; display: flex; align-items: center; gap: 6px;")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0E7A2F" strokeWidth="2" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg><Addr value={c.merchant} /></span> : "Not listed"],
                  ["Payment", <span style={st("color: #333333;")}>x402 exact · USDC</span>],
                  ["Listed", <span className="tn" style={st("color: #333333;")}>{dateOnly(l?.updatedAt)}</span>],
                ].map(([k, v], i, a) => (
                  <div key={k as string} style={st("display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; " + (i < a.length - 1 ? "border-bottom: 1px solid #EBEBEB;" : ""))}><dt style={st("color: #6B6B6B;")}>{k}</dt><dd style={st("margin: 0; display: flex; justify-content: flex-end;")}>{v}</dd></div>
                ))}
              </dl>
            </section>
          </aside>
        </div>

        {controls === "topup" && c && <TopUpDialog campaign={c} onClose={() => setControls(null)} onDone={(t) => { setControls(null); setNote(t); setTimeout(() => camp.retry(), 4000); }} />}
        {controls === "key" && c && <RotateKeyDialog campaign={c} onClose={() => setControls(null)} onDone={(t) => { setControls(null); setNote(t); setTimeout(() => camp.retry(), 4000); }} />}
        {note && <p role="status" style={st("font-size: 13px; line-height: 19px; color: #0E7A2F; background: #CAFACE; border-radius: 8px; padding: 10px 12px;")}>{note}</p>}
        {listing && c && <ListingModal campaign={c.address} existing={c.listing} onClose={() => setListing(false)} onDone={() => { setListing(false); camp.retry(); }} />}
        <Disclosure text={c.disclosure} style={{ borderTop: "1px solid #EBEBEB", paddingTop: 24 }} />
      </main>
    </Page>
  );
}
