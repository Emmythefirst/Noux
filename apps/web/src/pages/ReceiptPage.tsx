import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { st } from "../lib/css";
import { ApiError, explorerAddr, useApi, useCopy, useNow, type Campaign, type Receipt } from "../lib/api";
import { verifyReceipt, type StepState } from "../lib/verify";
import { fmtAmount, fullUtc, mmss, short, pctOf, projectedSplit } from "../lib/format";
import { isUnderpaid, openText, Addr, CopyIcon, Disclosure, ErrorState, Page, SampleBadge, STATUS_COLORS, TopNav, WakingBanner } from "../components/common";

const RING = "box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 1px -.5px rgb(0 0 0 / .06), 0 3px 3px -1.5px rgb(0 0 0 / .06), 0 6px 6px -3px rgb(0 0 0 / .06), 0 12px 12px -6px rgb(0 0 0 / .06);";
const dot = (c: string, filled: boolean) => st("width: 12px; height: 12px; margin-top: 4px; border-radius: 9999px; flex: none; " + (filled ? `background: ${c};` : `background: #FFFFFF; border: 2px solid ${c};`));
const LINE = st("width: 2px; flex: 1; min-height: 20px; background: #EBEBEB; margin-top: 4px;");

/** /receipts: send people to the newest receipt (there is no receipt list screen in the design). */
export function LatestReceipt() {
  const nav = useNavigate();
  const r = useApi<{ items: Receipt[] }>("/receipts?limit=1");
  useEffect(() => { if (r.data?.items[0]) nav(`/r/${r.data.items[0].sale}`, { replace: true }); }, [r.data, nav]);
  return (
    <Page bg="#FAFAFA"><TopNav surface="#FAFAFA" />
      <main style={st("max-width: 920px; margin: 0 auto; padding: 56px clamp(16px, 4vw, 48px);")}>
        {r.loading && (r.waking ? <WakingBanner /> : <p role="status" style={st("font-size: 14px; color: #6B6B6B;")}>Finding the latest receipt…</p>)}
        {r.error && <ErrorState title="Couldn’t load receipts" onRetry={r.retry} />}
        {r.data && r.data.items.length === 0 && <p style={st("font-size: 14px; color: #6B6B6B;")}>No receipts yet.</p>}
      </main>
    </Page>
  );
}

const CHECK_LABELS = ["Claim signature is valid for this campaign", "Payer equals the buyer named in the claim", "Split matches the on-chain terms", "Parts add up to exactly the amount paid"];

function Verify({ r }: { r: Receipt }) {
  const [results, setResults] = useState<StepState[] | null>(null);
  const [shown, setShown] = useState(-1); // how many results have been revealed (reveal is paced for readability; the results are already final)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = async () => {
    if (busy) return;
    setBusy(true); setErr(null); setResults(null); setShown(0);
    try {
      const res = await verifyReceipt({ sale: r.sale, openTx: r.links.open, paymentTx: r.links.payment, apiGross: r.gross, apiSplit: r.split });
      setResults(res);
      const reveal = (n: number) => { setShown(n); if (n < res.length) timer.current = setTimeout(() => reveal(n + 1), 260); else setBusy(false); };
      reveal(1);
    } catch (e) { setErr((e as Error).message || "RPC unavailable"); setBusy(false); setShown(-1); }
  };

  const revealed = results ? results.slice(0, shown) : [];
  const finished = !!results && shown >= results.length;
  const anyFail = revealed.some((x) => x.state === "fail");
  const label = busy ? "Checking…" : finished ? (anyFail ? "Check failed · run again" : "Verified · run again") : "Verify receipt";
  return (
    <section aria-labelledby="v-h" style={st("background: #FFFFFF; border: 1px solid #EBEBEB; border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 16px;")}>
      <div style={st("display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between;")}>
        <div style={st("display: flex; flex-direction: column; gap: 4px; max-width: 520px;")}>
          <h2 id="v-h" style={st("font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;")}>Don’t trust this page. Check it.</h2>
          <p style={st("font-size: 14px; line-height: 20px; color: #6B6B6B;")}>Your browser reads the sale account and the two transactions straight from a Solana node and re-does the checks. No Noux server is involved in the checks.</p>
        </div>
        <button className="press bi" type="button" onClick={run} aria-busy={busy} style={st("height: 40px; padding: 0 16px; border: 0; border-radius: 10px; background: #111111; color: #FFFFFF; font: 500 14px Inter, sans-serif; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; min-width: 168px; justify-content: center;")}>
          {busy && <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>}
          {label}
        </button>
      </div>
      {err && <p role="alert" style={st("font-size: 13px; color: #B42318;")}>Couldn’t reach a Solana node ({err}). Try again in a moment.</p>}
      <ul role="status" style={st("list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr)); gap: 0 24px;")}>
        {CHECK_LABELS.map((l, i) => {
          const res = i < shown ? results?.[i] : undefined;
          const active = busy && i === Math.max(0, shown) && (!results || i >= shown);
          const bg = res?.state === "pass" ? "#15B042" : res?.state === "fail" ? "#D92D20" : res?.state === "skip" ? "#D4D4D8" : undefined;
          return (
            <li key={l} style={st("display: flex; gap: 10px; align-items: flex-start; min-height: 44px; padding: 12px 0; border-top: 1px solid #EBEBEB; font-size: 14px;")}>
              <span style={{ ...st("width: 20px; height: 20px; flex: none; border-radius: 9999px; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; transition: background-color 200ms;"), ...(bg ? { background: bg } : active ? { border: "2px solid #0F766E", borderRightColor: "transparent" } : { border: "1.5px solid #D4D4D8" }) }}>
                {res?.state === "pass" && <svg className="chk" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>}
                {res?.state === "fail" && <svg className="chk" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>}
                {res?.state === "skip" && <span aria-hidden="true" style={st("width: 8px; height: 2px; background: #FFFFFF; border-radius: 1px;")} />}
              </span>
              <span style={st("display: flex; flex-direction: column; gap: 2px;")}>
                <span style={{ color: res?.state === "pass" ? "#111111" : res?.state === "fail" ? "#B42318" : "#6B6B6B" }}>{l}{res?.state === "skip" ? " · not applicable" : ""}{res?.state === "fail" ? " · failed" : ""}</span>
                {res?.detail && <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>{res.detail}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function ReceiptPage() {
  const { sale = "" } = useParams();
  const rc = useApi<Receipt>(`/receipts/${sale}`);
  const r = rc.data;
  const camp = useApi<Campaign>(r ? `/campaigns/${r.campaign}` : null);
  const now = useNow(1000);
  const [copied, copy] = useCopy();

  const shell = (body: React.ReactNode) => <Page bg="#FAFAFA"><TopNav surface="#FAFAFA" /><main style={st("max-width: 920px; margin: 0 auto; padding: 40px clamp(16px, 4vw, 48px) 96px; display: flex; flex-direction: column; gap: 24px;")}>{body}</main></Page>;
  if (rc.loading) return shell(rc.waking ? <WakingBanner /> : <p role="status" style={st("font-size: 14px; color: #6B6B6B;")}>Loading receipt…</p>);
  if (rc.error || !r) {
    const nf = rc.error instanceof ApiError && rc.error.status === 404;
    return shell(<ErrorState title={nf ? "Receipt not found" : "Couldn’t load this receipt"} body={nf ? "No sale with that address is indexed. It may be brand new (the index runs about every 20 s), or the sale was closed unpaid." : undefined} onRetry={nf ? undefined : rc.retry} />);
  }

  const dec = r.decimals;
  const held = r.status === "open";
  const refunded = r.status === "refunded";
  const settled = r.status === "settled";
  const under = isUnderpaid(r);
  const sc = under ? STATUS_COLORS.refunded : STATUS_COLORS[r.status];
  const left = held && r.holdUntil ? (new Date(r.holdUntil).getTime() - now) / 1000 : 0;
  const statusText = held ? openText(r, left) : sc.label;
  const name = r.listing?.name ?? "Unlisted campaign";
  const g = r.status === "open" ? (r.funded ? r.vaultAmount : r.price) : r.gross;
  const split = r.status === "open" ? projectedSplit(g, r.policy.commissionBps, r.policy.feeBps) : r.split; // a held sale has not split yet: show what it will pay out
  const f = (v: string) => fmtAmount(v, dec);
  const pct = (v: string) => pctOf(v, g).toFixed(2) + "%";
  const sumLine = refunded
    ? `${f(g)} returned to ${short(r.parties.buyer)} · no commission paid`
    : `${under ? "Underpaid, so it will not pay out. At this amount it would split: " : held ? "Will pay out: " : ""}${f(split.merchant)} + ${f(split.distributor)} + ${f(split.protocolFee)} = ${f(g)} USDC · fee and commission rounded down, merchant gets the remainder`;

  const segBase = "min-width: 0; display: flex; align-items: center; color: #FFFFFE; "; // fixed white: the segments keep their colours in dark mode
  const pend: CSSProperties = held && !under ? { backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,.14) 0 7px, transparent 7px 14px)", backgroundSize: "28px 80px" } : {};
  const mFlex = Number(split.merchant), dFlex = Number(split.distributor), fFlex = Number(split.protocolFee);

  type Part = { name: string; pct: string; addr: string | null; amt: string; swatch: string; color: string; anim: string };
  const parts: Part[] = refunded ? [
    { name: "Buyer refund", pct: "100.00%", addr: r.parties.buyer, amt: f(g), swatch: "width: 16px; height: 10px; border-radius: 3px; border: 1px dashed #8A8A8A; background: #F4F4F5;", color: "#111111", anim: "l1" },
    { name: "Distributor", pct: "no commission", addr: r.parties.distributor, amt: f("0"), swatch: "width: 16px; height: 10px; border-radius: 3px; background: #0F766F; opacity: .3;", color: "#6B6B6B", anim: "l2" },
    { name: "Merchant", pct: "no payout", addr: r.parties.merchant, amt: f("0"), swatch: "width: 16px; height: 10px; border-radius: 3px; background: #111112; opacity: .3;", color: "#6B6B6B", anim: "l3" },
  ] : [
    { name: "Merchant", pct: pct(split.merchant), addr: r.parties.merchant, amt: f(split.merchant), swatch: "width: 16px; height: 10px; border-radius: 3px; background: #111112;", color: "#111111", anim: "l1" },
    { name: "Distributor", pct: pct(split.distributor), addr: r.parties.distributor, amt: f(split.distributor), swatch: "width: 16px; height: 10px; border-radius: 3px; background: #0F766F;", color: "#0F766E", anim: "l2" },
    { name: "Protocol fee", pct: pct(split.protocolFee), addr: r.parties.feeOwner ?? null, amt: f(split.protocolFee), swatch: "width: 16px; height: 10px; border-radius: 3px; background: #D4D4D9;", color: "#111111", anim: "l3" },
  ];

  const unpaid = held && !r.funded;
  const lastTitle = under ? "Underpaid: can’t settle" : unpaid ? "Waiting for payment" : held ? "Settles after the hold" : refunded ? "Refunded by merchant" : "Settled";
  const lastMeta = under ? `The vault holds ${f(r.vaultAmount)} of the ${f(r.price)} claim price. The program refuses to settle an underpaid sale; only the merchant can refund it.` : held
    ? `${left > 0 ? mmss(left) + " left · " : ""}anyone can settle after ${fullUtc(r.holdUntil)}`
    : refunded ? `${fullUtc(r.settledAt)} · inside the hold`
    : `${fullUtc(r.settledAt)}${r.holdUntil && r.settledAt && new Date(r.settledAt) > new Date(r.holdUntil) ? ` · ${Math.round((new Date(r.settledAt).getTime() - new Date(r.holdUntil).getTime()) / 1000)} s after the hold ended` : ""}`;
  const lastTx = refunded ? r.links.refund : r.links.settlement;
  const txShort = (u: string | null) => { const m = u?.match(/\/tx\/([1-9A-HJ-NP-Za-km-z]+)/); return m ? short(m[1]) : "Pending"; };
  const events = [
    { title: "Sale opened · claim accepted", meta: fullUtc(r.openedAt), tx: r.links.open, dot: dot("#111111", true), last: false },
    { title: "Paid via x402", meta: "Payment into the sale vault", tx: r.links.payment, dot: dot("#111111", true), last: false },
    { title: lastTitle, meta: lastMeta, tx: lastTx, dot: held ? dot("#0058B0", false) : refunded ? dot("#8A4B00", true) : dot("#15B042", true), last: true },
  ];

  const rate = camp.data?.sales.refundRate;
  const closed = camp.data ? camp.data.sales.settled + camp.data.sales.refunded : 0;

  return (
    <Page bg="#FAFAFA">
      <TopNav surface="#FAFAFA" />
      <main className="rc" style={st("max-width: 920px; margin: 0 auto; padding: 40px clamp(16px, 4vw, 48px) 96px; display: flex; flex-direction: column; gap: 24px;")}>
        <div style={st("display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;")}>
          <nav aria-label="Breadcrumb" style={st("font-size: 13px; color: #6B6B6B; display: flex; gap: 8px; align-items: center;")}><Link to={`/campaigns/${r.campaign}`} style={st("color: #6B6B6B;")}>{name}</Link><span aria-hidden="true">/</span><span style={st("color: #111111;")}>Receipt</span></nav>
          <button className="press bs" type="button" onClick={() => copy("link", window.location.href)} style={st("height: 32px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>{copied === "link" ? "Link copied" : "Copy link"}
          </button>
        </div>

        <article aria-labelledby="rc-h" style={st("background: #FFFFFF; border-radius: 24px; overflow: hidden; " + RING)}>
          <div style={st("padding: clamp(24px, 4vw, 40px); display: flex; flex-direction: column; gap: 32px;")}>
            <div style={st("display: flex; flex-wrap: wrap; gap: 12px; align-items: center;")}>
              <h1 id="rc-h" style={st("font-size: 13px; font-weight: 500; color: #111111;")}>Receipt</h1>
              <span className="mono" title={r.sale} style={st("font-size: 12px; color: #333333; background: #F4F4F5; border-radius: 4px; padding: 2px 6px;")}>{short(r.sale)}</span>
              <button className="press ib" type="button" aria-label="Copy sale address" onClick={() => copy("sale", r.sale)} style={st("width: 28px; height: 28px; border: 0; background: transparent; border-radius: 8px; color: #6B6B6B; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;")}>{copied === "sale" ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg> : <CopyIcon />}</button>
              <span style={{ flex: 1 }} />
              {r.listing?.isSample && <SampleBadge />}
              <span style={{ ...st("height: 20px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px;"), background: sc.bg, color: sc.fg }}><span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 9999, background: sc.dot }} />{statusText}</span>
            </div>

            <div style={st("display: flex; flex-wrap: wrap; gap: 16px 40px; align-items: flex-end; justify-content: space-between;")}>
              <div style={st("display: flex; flex-direction: column; gap: 6px;")}>
                <span style={st("font-size: 14px; color: #6B6B6B;")}>{refunded ? "Buyer paid, then refunded" : unpaid ? "Awaiting payment of" : "Buyer paid"}</span>
                <div className="tn" style={st("display: flex; align-items: baseline; gap: 10px;")}><span style={st("font-size: clamp(2.75rem, 1.8rem + 3vw, 4.5rem); line-height: 1; letter-spacing: -0.04em; font-weight: 500; color: #111111;")}>{f(g)}</span><span style={st("font-size: 20px; color: #6B6B6B;")}>USDC</span></div>
              </div>
              <div className="tn" style={st("display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #6B6B6B; text-align: right;")}>
                <span>{name}{r.listing && <> · <span className="mono" style={st("font-size: 12px;")}>{r.listing.route}</span></>}</span>
                <span>{fullUtc(r.openedAt)}</span>
              </div>
            </div>

            <div style={st("display: flex; flex-direction: column; gap: 16px;")}>
              {!refunded && (
                <div style={st("position: relative; height: 80px;")}>
                  <div className="seg-in" style={st("display: flex; gap: 6px; height: 80px;")}>
                    <div style={{ ...st(segBase + "background-color: #111112; border-radius: 14px 6px 6px 14px; padding: 0 20px; justify-content: space-between; gap: 8px;"), flex: `${mFlex} 1 0`, ...pend }}><span style={st("font-size: 14px; font-weight: 500;")}>Merchant</span><span className="tn" style={st("font-size: 13px; opacity: .8;")}>{pctOf(split.merchant, g).toFixed(0)}%</span></div>
                    <div style={{ ...st(segBase + "min-width: 72px; background-color: #0F766F; border-radius: 6px; justify-content: center;"), flex: `${dFlex} 1 0`, ...pend }}><span className="tn" style={st("font-size: 14px; font-weight: 500;")}>{pctOf(split.distributor, g).toFixed(0)}%</span></div>
                    <div style={{ ...st("min-width: 14px; background: #D4D4D9; border-radius: 6px 14px 14px 6px;"), flex: `${Math.max(fFlex, 1)} 1 0` }} />
                  </div>
                  <div className="unite" aria-hidden="true" style={st("position: absolute; inset: 0; background: #111112; border-radius: 14px;")} />
                </div>
              )}
              {refunded && (
                <div style={st("height: 80px; border-radius: 14px; background: #F4F4F5; border: 1px dashed #8A8A8A; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; gap: 12px;")}>
                  <span style={st("font-size: 14px; font-weight: 500; color: #111111; display: flex; align-items: center; gap: 8px;")}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="1.5" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>Returned to buyer</span>
                  <span className="tn" style={st("font-size: 14px; font-weight: 500; color: #111111;")}>100%</span>
                </div>
              )}

              <dl style={st("margin: 0; display: flex; flex-direction: column;")}>
                {parts.map((p) => (
                  <div key={p.name} className={p.anim} style={st("display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 14px; align-items: center; min-height: 56px; padding: 8px 0; border-bottom: 1px solid #EBEBEB;")}>
                    <span aria-hidden="true" style={st(p.swatch)} />
                    <div style={st("display: flex; flex-direction: column; gap: 2px; min-width: 0;")}>
                      <dt style={st("font-size: 15px; color: #111111; font-weight: 500;")}>{p.name} <span className="tn" style={st("font-size: 13px; color: #6B6B6B; font-weight: 400; margin-left: 4px;")}>{p.pct}</span></dt>
                      <span style={st("font-size: 12px; color: #6B6B6B; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;")}>
                        {p.addr ? <><span className="mono" title={p.addr}>{short(p.addr)}</span><a href={explorerAddr(p.addr)} target="_blank" rel="noreferrer" style={st("font-size: 12px;")}>Explorer ↗</a></> : <span>Fee recipient is set by the campaign</span>}
                      </span>
                    </div>
                    <dd className="tn" style={{ ...st("margin: 0; font-size: 18px; letter-spacing: -0.01em; font-weight: 500; text-align: right;"), color: p.color }}>{p.amt} <span style={st("font-size: 13px; color: #6B6B6B; font-weight: 400;")}>USDC</span></dd>
                  </div>
                ))}
              </dl>
              <p className="mono tn" style={st("font-size: 12px; color: #6B6B6B; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0E7A2F" strokeWidth="2" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>{sumLine}
              </p>
            </div>
          </div>

          <div style={st("border-top: 1px solid #EBEBEB; background: #FAFAFA; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));")}>
            <section aria-labelledby="t-h" style={st("padding: 28px clamp(24px, 4vw, 40px); display: flex; flex-direction: column; gap: 16px; border-right: 1px solid #EBEBEB;")}>
              <h2 id="t-h" style={st("font-size: 13px; font-weight: 500; color: #6B6B6B;")}>On-chain history</h2>
              <ol style={st("list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;")}>
                {events.map((e) => (
                  <li key={e.title} style={st("display: grid; grid-template-columns: 20px 1fr; gap: 14px;")}>
                    <div style={st("display: flex; flex-direction: column; align-items: center;")}><span aria-hidden="true" style={e.dot} /><span aria-hidden="true" style={e.last ? st("display: none;") : LINE} /></div>
                    <div style={st("display: flex; flex-direction: column; gap: 4px; padding-bottom: 20px;")}>
                      <span style={st("font-size: 14px; font-weight: 500; color: #111111;")}>{e.title}</span>
                      <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>{e.meta}</span>
                      <span style={st("display: flex; gap: 8px; align-items: center; font-size: 12px;")}>
                        <span className="mono" style={st("color: #333333;")}>{txShort(e.tx)}</span>
                        {e.tx && <a href={e.tx} target="_blank" rel="noreferrer">Open in explorer ↗</a>}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section aria-labelledby="po-h" style={st("padding: 28px clamp(24px, 4vw, 40px); display: flex; flex-direction: column; gap: 16px;")}>
              <h2 id="po-h" style={st("font-size: 13px; font-weight: 500; color: #6B6B6B;")}>Policy applied</h2>
              <dl className="tn" style={st("margin: 0; display: flex; flex-direction: column; font-size: 13px;")}>
                {([
                  ["Commission", <>{(r.policy.commissionBps / 100).toFixed(2)}% <span style={st("color: #6B6B6B;")}>· {r.policy.commissionBps} bps</span></>],
                  ["Protocol fee", <>{(r.policy.feeBps / 100).toFixed(2)}% <span style={st("color: #6B6B6B;")}>· {r.policy.feeBps} bps</span></>],
                  ["Hold", <>{r.policy.holdSecs} s from sale open</>],
                  ["Budget cap reduced commission", <>{settled ? (r.policy.budgetCapApplied ? "Yes" : "No") : "—"}</>],
                  ["Buyer", <span className="mono" style={st("font-size: 12px;")}>{short(r.parties.buyer)}</span>],
                  ["Campaign", <Link className="mono" to={`/campaigns/${r.campaign}`} style={st("font-size: 12px;")}>{short(r.campaign)}</Link>],
                  ["Sale account", <a className="mono" href={r.links.saleAccount} target="_blank" rel="noreferrer" style={st("font-size: 12px;")}>{short(r.sale)} ↗</a>],
                ] as [string, React.ReactNode][]).map(([k, v], i, a) => (
                  <div key={k} style={st("display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; " + (i < a.length - 1 ? "border-bottom: 1px solid #EBEBEB;" : ""))}><dt style={st("color: #6B6B6B;")}>{k}</dt><dd style={st("margin: 0; color: #111111;")}>{v}</dd></div>
                ))}
              </dl>
            </section>
          </div>
        </article>

        <Verify r={r} />

        <section style={st("display: flex; flex-direction: column; gap: 6px; padding: 0 4px;")}>
          <h2 style={st("font-size: 13px; font-weight: 500; color: #111111;")}>About refunds</h2>
          <p style={st("font-size: 13px; line-height: 20px; color: #6B6B6B; max-width: 640px;")}>
            If the service fails after you pay, the merchant can refund you before settlement. After settlement it is final. A refund is the merchant’s choice, not a guarantee.
            {camp.data && <> This campaign’s refund rate is <span className="tn" style={st("color: #111111;")}>{rate === null || rate === undefined ? "—" : (rate * 100).toFixed(1) + "%"}</span> across {closed} closed sale{closed === 1 ? "" : "s"}.</>}
          </p>
        </section>

        <Disclosure style={{ borderTop: "1px solid #EBEBEB", padding: "24px 4px 0" }} />
      </main>
    </Page>
  );
}
