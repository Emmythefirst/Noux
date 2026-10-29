import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { st } from "../lib/css";
import { ApiError, useApi, type CampaignDetail } from "../lib/api";
import { bpsPct, fmtAmount, short } from "../lib/format";
import { PROGRAM_ID, ata, USDC_MINT } from "../lib/program";
import { useWallet } from "../lib/wallet-connect";
import { discoverPrice, encodeClaimHeader, payWithWallet, requestClaim, usdcBalance, type PaymentRequirement } from "../lib/buy";
import { checkRequirement } from "../lib/buy-checks";
import { CHAIN } from "../lib/chain";
import { isPubkey } from "../lib/wallet";
import { addPurchase, purchasesFor, type Purchase } from "../lib/purchases";
import { dayTime } from "../lib/format";
import { Disclosure, ErrorState, Page, SampleBadge, TopNav, WakingBanner } from "../components/common";
import { WalletButton } from "../components/wallet-ui";

type StepState = "todo" | "doing" | "done" | "failed";
const FAUCET = "https://faucet.circle.com/";

function Steps({ steps }: { steps: { label: string; state: StepState }[] }) {
  return (
    <ol role="status" style={st("list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;")}>
      {steps.map((s) => (
        <li key={s.label} style={st("display: flex; gap: 10px; align-items: center; min-height: 40px; border-top: 1px solid #EBEBEB; font-size: 14px;")}>
          <span style={{ ...st("width: 20px; height: 20px; flex: none; border-radius: 9999px; display: inline-flex; align-items: center; justify-content: center;"), ...(s.state === "done" ? { background: "#15B042" } : s.state === "failed" ? { background: "#D92D20" } : s.state === "doing" ? { border: "2px solid #0F766E", borderRightColor: "transparent" } : { border: "1.5px solid #D4D4D8" }) }}>
            {s.state === "done" && <svg className="chk" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>}
            {s.state === "failed" && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>}
            {s.state === "doing" && <span className="spin" style={st("width: 20px; height: 20px; display: block;")} />}
          </span>
          <span style={{ color: s.state === "todo" ? "#6B6B6B" : s.state === "failed" ? "#B42318" : "#111111" }}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

export default function Buy() {
  const { campaign = "" } = useParams();
  const [sp] = useSearchParams();
  const refRaw = sp.get("ref") ?? "";
  const ref = isPubkey(refRaw) ? refRaw : "";
  const w = useWallet();
  const camp = useApi<CampaignDetail>(`/campaigns/${campaign}`);
  const c = camp.data;
  const url = c?.listing?.endpointUrl ?? null;
  const isGet = !c?.listing || /^GET\b/i.test(c.listing.route);

  const [price, setPrice] = useState<PaymentRequirement | null>(null);
  const [priceErr, setPriceErr] = useState<string | null>(null);
  useEffect(() => {
    setPrice(null); setPriceErr(null);
    if (!url) return;
    let live = true;
    discoverPrice(url).then((d) => { if (live) setPrice(d.requirement); }).catch((e: Error) => { if (live) setPriceErr(/fetch/i.test(e.message) ? "The service didn’t answer from the browser. It may be asleep (free hosting) or not set up for browsers." : e.message); });
    return () => { live = false; };
  }, [url]);

  const [balance, setBalance] = useState<bigint | null>(null);
  useEffect(() => {
    setBalance(null);
    if (!w.address) return;
    let live = true;
    usdcBalance(ata(new PublicKey(w.address)).toBase58()).then((b) => { if (live) setBalance(b); }).catch(() => { if (live) setBalance(null); });
    return () => { live = false; };
  }, [w.address]);

  const [mode, setMode] = useState<"referred" | "plain">(ref ? "referred" : "plain");
  const [steps, setSteps] = useState<{ label: string; state: StepState }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; code?: string } | null>(null);
  const [result, setResult] = useState<{ status: number; body: string; tx?: string; sale?: string } | null>(null);
  const running = useRef(false);
  const [past, setPast] = useState<Purchase[]>([]);
  useEffect(() => { setPast(w.address ? purchasesFor(campaign, w.address) : []); }, [campaign, w.address, result]);

  const mark = (i: number, state: StepState, all: string[]) => setSteps(all.map((label, k) => ({ label, state: k < i ? "done" : k === i ? state : "todo" })));

  const buy = async (as: "referred" | "plain") => {
    if (running.current || !w.address || !url || !price) return;
    if (c && checkRequirement(price, { campaignMint: c.mint, decimals: c.decimals, chain: CHAIN, displayPrice: c.listing?.displayPrice })) return; // belt and braces: never reach the wallet with a mismatching 402
    running.current = true; setBusy(true); setErr(null); setResult(null);
    const labels = as === "referred" ? ["Sign the referral request", "Get your claim", "Approve the payment", "Receive the result"] : ["Approve the payment", "Receive the result"];
    let i = 0;
    try {
      let claimHeader: string | undefined, sale: string | undefined;
      if (as === "referred") {
        mark(0, "doing", labels);
        const claim = await requestClaim({ campaign, distributor: ref, buyer: w.address, price: price.amount, signMessage: w.signMessage });
        i = 1; mark(1, "doing", labels);
        claimHeader = encodeClaimHeader(claim);
        const nonce = Uint8Array.from((claim.nonce as string).match(/../g)!.map((h) => parseInt(h, 16)));
        sale = PublicKey.findProgramAddressSync([new TextEncoder().encode("sale"), new PublicKey(campaign).toBytes(), nonce], PROGRAM_ID)[0].toBase58();
        i = 2;
      }
      mark(i, "doing", labels);
      const r = await payWithWallet({ url, claimHeader, address: w.address, signRaw: w.signRaw });
      if (r.status !== 200) throw new Error(`The service answered ${r.status} after payment was attempted. If money left your wallet it will show on the receipt; the merchant can refund before settlement.`);
      mark(labels.length, "done", labels);
      addPurchase({ campaign, buyer: w.address, sale, tx: r.tx, at: Date.now(), referred: as === "referred" });
      setResult({ ...r, sale });
      usdcBalance(ata(new PublicKey(w.address)).toBase58()).then(setBalance).catch(() => {});
    } catch (e: any) {
      mark(i, "failed", labels);
      setErr({ text: e?.message ?? "Something went wrong.", code: e?.code });
    } finally { running.current = false; setBusy(false); }
  };

  const shell = (body: React.ReactNode) => <Page><TopNav /><main style={st("max-width: 640px; margin: 0 auto; padding: 40px clamp(16px, 4vw, 48px) 96px; display: flex; flex-direction: column; gap: 20px;")}>{body}</main></Page>;
  if (camp.loading) return shell(camp.waking ? <WakingBanner /> : <p role="status" style={st("font-size: 14px; color: #6B6B6B;")}>Loading…</p>);
  if (camp.error || !c) return shell(<ErrorState title={camp.error instanceof ApiError && camp.error.status === 404 ? "Campaign not found" : "Couldn’t load this campaign"} onRetry={camp.retry} />);
  if (!c.listing) return shell(<ErrorState title="This campaign is unlisted" body="Its merchant hasn’t published where the service lives, so there is nothing to buy here. Ask the merchant for their listing." />);

  const l = c.listing;
  const need = price ? BigInt(price.amount) : null;
  const short$ = balance !== null && need !== null && balance < need;
  // the 402 comes from the merchant's own server: check it against the campaign and its listing before the wallet is ever asked to pay
  const mismatch = price ? checkRequirement(price, { campaignMint: c.mint, decimals: c.decimals, chain: CHAIN, displayPrice: l.displayPrice }) : null;
  const canPay = !!w.address && !!price && !busy && isGet && !mismatch;
  const selfRef = !!w.address && ref !== "" && w.address === ref;

  return shell(
    <>
      <nav aria-label="Breadcrumb" style={st("font-size: 13px; color: #6B6B6B; display: flex; gap: 8px;")}><Link to="/campaigns" style={st("color: #6B6B6B;")}>Campaigns</Link><span aria-hidden="true">/</span><Link to={`/campaigns/${c.address}`} style={st("color: #6B6B6B;")}>{l.name}</Link><span aria-hidden="true">/</span><span style={st("color: #111111;")}>Buy</span></nav>
      <div style={st("display: flex; flex-direction: column; gap: 8px;")}>
        <div style={st("display: flex; align-items: center; gap: 10px; flex-wrap: wrap;")}>
          <h1 style={st("font-size: 32px; line-height: 36px; letter-spacing: -0.025em; font-weight: 500; color: #111111;")}>{l.name}</h1>
          {l.isSample && <SampleBadge />}
        </div>
        <p style={st("font-size: 14px; line-height: 20px; color: #333333;")}>{l.description}</p>
      </div>

      <section aria-label="Payment" style={st("border: 1px solid #EBEBEB; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 16px;")}>
        <div style={st("display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap;")}>
          <span style={st("font-size: 13px; color: #6B6B6B;")}>You pay</span>
          <span className="tn" style={st("font-size: 32px; letter-spacing: -0.025em; font-weight: 500; color: #111111;")}>{price ? fmtAmount(price.amount) : priceErr ? "—" : "…"} <span style={st("font-size: 14px; color: #6B6B6B; font-weight: 400;")}>USDC · devnet</span></span>
        </div>
        {priceErr && <p role="alert" style={st("font-size: 13px; color: #B42318;")}>{priceErr}</p>}
        {mismatch && <p role="alert" style={st("font-size: 13px; line-height: 19px; color: #B42318; background: #FFE8E6; border-radius: 8px; padding: 10px 12px;")}>{mismatch}</p>}
        <p style={st("font-size: 13px; line-height: 20px; color: #6B6B6B;")}>
          {ref ? <>Referred by <span className="mono" title={ref}>{short(ref)}</span>. The price is the same with or without a referral: the referrer is paid {bpsPct(c.commissionBps, c.commissionBps % 100 ? 2 : 0)} out of the merchant’s share when the sale settles. </> : <>No referral on this link, so the merchant is paid in full. </>}
          The merchant can refund you before settlement ({c.holdSecs} s hold); after that it is final. This is devnet test money.
        </p>

        {!w.address ? (
          <div style={st("display: flex; flex-direction: column; gap: 8px; align-items: flex-start;")}><span style={st("font-size: 13px; color: #333333;")}>Connect your wallet to pay.</span><WalletButton align="left" /></div>
        ) : (
          <>
            {past.length > 0 && !result && (
              <div role="note" style={st("border: 1px solid #B3D4FF; background: rgba(0,88,176,0.05); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 18px; color: #333333;")}>
                <span><strong>You already bought this {past.length === 1 ? "once" : `${past.length} times`} with this wallet.</strong> Paying again buys it again and charges you again.</span>
                {past.slice(0, 3).map((p) => <span key={p.at} className="tn" style={st("color: #6B6B6B;")}>{dayTime(new Date(p.at).toISOString())} · {p.sale ? <Link to={`/r/${p.sale}`}>View receipt</Link> : "plain purchase"}{p.tx && <> · <a href={`https://explorer.solana.com/tx/${p.tx}?cluster=devnet`} target="_blank" rel="noreferrer">payment ↗</a></>}</span>)}
              </div>
            )}
            <div className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>Paying from <span className="mono">{short(w.address)}</span> · devnet USDC balance {balance === null ? "…" : fmtAmount(balance)}</div>
            {short$ && <p role="alert" style={st("font-size: 13px; line-height: 18px; color: #8A4B00;")}>Your wallet has less devnet USDC than the price. Get free test USDC from <a href={FAUCET} target="_blank" rel="noreferrer">faucet.circle.com</a> (choose Solana Devnet and paste your address), then try again.</p>}
            {selfRef && <p role="alert" style={st("font-size: 13px; line-height: 18px; color: #8A4B00;")}>This is your own referral link: you can’t refer yourself, so the referral won’t count. You can still buy without it.</p>}
            {!isGet && <p role="alert" style={st("font-size: 13px; color: #B42318;")}>This service isn’t a simple GET request, so it can’t be bought from this page.</p>}
            <div style={st("display: flex; gap: 8px; flex-wrap: wrap;")}>
              {ref && !selfRef && <button className="press bp" type="button" disabled={!canPay} onClick={() => void buy("referred")} style={{ ...st("height: 44px; padding: 0 20px; border: 0; border-radius: 9999px; background: #0F766E; color: #FFFFFF; font: 500 15px Inter, sans-serif; cursor: pointer;"), opacity: canPay ? 1 : 0.5 }}>{busy ? "Working…" : `${past.length ? "Pay again" : "Pay"} ${price ? fmtAmount(price.amount) : ""} USDC`}</button>}
              <button className={ref && !selfRef ? "press bs" : "press bp"} type="button" disabled={!canPay} onClick={() => void buy("plain")} style={{ ...st(ref && !selfRef ? "height: 44px; padding: 0 20px; border-radius: 9999px; background: #FFFFFF; color: #111111; border: 1px solid #D4D4D8; font: 500 15px Inter, sans-serif; cursor: pointer;" : "height: 44px; padding: 0 20px; border: 0; border-radius: 9999px; background: #0F766E; color: #FFFFFF; font: 500 15px Inter, sans-serif; cursor: pointer;"), opacity: canPay ? 1 : 0.5 }}>{ref && !selfRef ? "Buy without the referral" : busy ? "Working…" : `${past.length ? "Pay again" : "Pay"} ${price ? fmtAmount(price.amount) : ""} USDC`}</button>
            </div>
          </>
        )}

        {steps.length > 0 && <Steps steps={steps} />}
        {err && (
          <div role="alert" style={st("display: flex; flex-direction: column; gap: 8px; font-size: 13px; line-height: 18px; color: #B42318;")}>
            <span>{err.code === "self_referral" ? "You can’t refer yourself. Use “Buy without the referral”." : err.code === "rate_limited" ? "Too many requests right now. Wait a minute and try again." : err.text}</span>
          </div>
        )}
      </section>

      {result && (
        <section aria-label="Result" className="fadein" style={st("border: 1px solid #EBEBEB; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 12px;")}>
          <h2 style={st("font-size: 16px; font-weight: 500; color: #111111;")}>Paid. Here is what you bought</h2>
          <pre className="mono" style={st("margin: 0; padding: 12px; background: #FAFAFA; border: 1px solid #EBEBEB; border-radius: 8px; font-size: 12px; line-height: 18px; color: #333333; overflow-x: auto; max-height: 260px;")}>{(() => { try { return JSON.stringify(JSON.parse(result.body), null, 2); } catch { return result.body; } })()}</pre>
          <div style={st("display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px;")}>
            {result.sale && <Link to={`/r/${result.sale}`} style={st("font-weight: 500;")}>View the receipt →</Link>}
            {result.tx && <a href={`https://explorer.solana.com/tx/${result.tx}?cluster=devnet`} target="_blank" rel="noreferrer">Payment transaction ↗</a>}
          </div>
          <p style={st("font-size: 12px; line-height: 18px; color: #6B6B6B;")}>{result.sale ? `The receipt shows “Held” until the ${c.holdSecs}-second hold ends, then “Settled” with the split. It can take up to a minute to appear.` : "This was a plain purchase: the merchant was paid in full."}</p>
        </section>
      )}
      <Disclosure />
    </>,
  );
}
