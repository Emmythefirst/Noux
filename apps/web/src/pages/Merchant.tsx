import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { st } from "../lib/css";
import { API_BASE, apiGet, useIndexFreshness, useApi, useNow, type Campaign, type Page as ApiPage, type Receipt } from "../lib/api";
import { PublicKey } from "@solana/web3.js";
import { CATEGORIES, dayTime, fmt2, fmtAmount, fmtShort, mmss, short } from "../lib/format";
import { campaignPda, createCampaignIx, listingMessage, newTx, parseAmount, refundSaleIx } from "../lib/program";
import { getBlockhash, useWallet } from "../lib/wallet-connect";
import { RPC_URL } from "../lib/verify";
import { WalletButton } from "../components/wallet-ui";
import { NavMenu } from "../components/navdrawer";
import { isPubkey, useWalletAddress } from "../lib/wallet";
import { AppSidebar, ViewingBar, WalletForm } from "../components/appshell";
import { openText, DevnetBadge, Dot, ErrorState, Freshness, SampleBadge, SaleBadge, WakingBanner } from "../components/common";

const H2 = "font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;";
const SAMPLE_MERCHANT = "4Gb6hyx49dTZN1p1dagrcJne5tYNxYqaDXJZVkb29nT7"; // the Noux demo merchant wallet
const MAX_CAMPAIGNS = 8;
const FEE_BPS = 100;
type Tab = "all" | "open" | "settled" | "refunded";

function useMerchantSales(addresses: string[]) {
  const key = addresses.join(",");
  const [state, setState] = useState<{ loading: boolean; error: boolean; items: Receipt[] }>({ loading: addresses.length > 0, error: false, items: [] });
  useEffect(() => {
    if (addresses.length === 0) { setState({ loading: false, error: false, items: [] }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: false }));
    Promise.all(addresses.map((a) => apiGet<ApiPage<Receipt>>(`/campaigns/${a}/sales?limit=100`)))
      .then((pages) => { if (live) setState({ loading: false, error: false, items: pages.flatMap((p) => p.items).sort((a, b) => +new Date(b.settledAt ?? b.openedAt ?? 0) - +new Date(a.settledAt ?? a.openedAt ?? 0)) }); })
      .catch(() => { if (live) setState({ loading: false, error: true, items: [] }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

interface ClaimService { attributionKey: string; cluster: string; programId: string; claimTtlSecs: number }
const FIELD = "height: 40px; padding: 0 12px; border: 1px solid #8A8A8A; border-radius: 8px; font: 400 14px Inter, sans-serif; color: #111111; background: #FFFFFF; width: 100%;";
const LABEL = "font-size: 13px; font-weight: 500; color: #333333;";

function CreateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (campaign: string) => void }) {
  const w = useWallet();
  const protocol = useApi<{ protocol: { feeBps: number; maxFeeBps: number } | null }>("/stats");
  const feeBps = protocol.data?.protocol?.feeBps ?? null;
  const [comm, setComm] = useState(15);
  const [budget, setBudget] = useState("50.00");
  const [hold, setHold] = useState(120);
  const [name, setName] = useState(""), [desc, setDesc] = useState(""), [cat, setCat] = useState("data-feeds"), [url, setUrl] = useState(""), [route, setRoute] = useState("GET /"), [price, setPrice] = useState("$0.10");
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const gross = 100000, fee = feeBps === null ? 0 : Math.floor((gross * feeBps) / 10000), c = Math.floor((gross * comm * 100) / 10000), m = gross - fee - c;
  const b = (() => { try { return parseAmount(budget); } catch { return null; } })();
  const covers = c > 0 && b !== null ? Math.floor(Number(b) / c) : 0;
  const f = (n: number) => fmtAmount(String(n));
  const busy = step !== null;
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose, busy]);

  const problems = (): string | null => {
    if (!w.address) return "Connect a wallet first.";
    if (b === null || b <= 0n) return "Enter a commission budget greater than zero (plain number, up to 6 decimals).";
    if (!name.trim() || name.length > 60) return "Name is required (up to 60 characters).";
    if (!desc.trim() || desc.length > 280) return "Description is required (up to 280 characters).";
    if (!/^https:\/\/[^\s/$.?#].[^\s]*$/.test(url) || url.length > 200) return "Endpoint URL must be a public https address.";
    if (!route.trim() || route.length > 80) return "Route is required, for example GET /report.";
    if (!price.trim() || price.length > 20) return "Display price is required, for example $0.10.";
    if (feeBps === null) return "Couldn’t read the protocol fee. Try again in a moment.";
    return null;
  };

  const submit = async () => {
    const p = problems(); if (p) { setErr(p); return; }
    setErr(null);
    try {
      setStep("Preparing…");
      const svc = await apiGet<ClaimService>("/claim-service");
      const merchant = new PublicKey(w.address!);
      const id = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (x) => x.toString(16).padStart(2, "0")).join(""));
      const tx = newTx(createCampaignIx({ merchant, campaignId: id, commissionBps: comm * 100, budget: b!, attributionKey: new PublicKey(svc.attributionKey), cluster: svc.cluster, holdSecs: hold }), merchant, await getBlockhash());
      setStep("Approve the transaction in your wallet…");
      await w.signAndSend(tx);
      const campaign = campaignPda(merchant, id).toBase58();
      const listing = { name: name.trim(), description: desc.trim(), category: cat, endpointUrl: url.trim(), route: route.trim(), displayPrice: price.trim(), isSample: false };
      setStep("Sign the listing message in your wallet…");
      const ts = Math.floor(Date.now() / 1000);
      const sig = await w.signMessage(await listingMessage(campaign, listing, ts));
      setStep("Publishing the listing…");
      let last = "";
      for (let i = 0; i < 6; i++) { // the index reads the new campaign from the chain; give it a few seconds
        const r = await fetch(`${API_BASE}/campaigns/${campaign}/listing`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ listing, ts, signature: btoa(String.fromCharCode(...sig)) }) });
        if (r.ok) { onCreated(campaign); return; }
        last = ((await r.json().catch(() => null)) as any)?.error?.message ?? `HTTP ${r.status}`;
        if (r.status !== 404) break;
        await new Promise((res) => setTimeout(res, 2000));
      }
      throw new Error(`The campaign was created on-chain (${short(campaign)}), but publishing the listing failed: ${last}`);
    } catch (e) { setErr((e as Error).message); setStep(null); }
  };

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} style={st("position: fixed; inset: 0; z-index: 50; background: rgb(0 0 0 / .4);")} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="cc-h" style={st("position: fixed; top: 8px; right: 8px; bottom: 8px; z-index: 51; width: min(520px, calc(100% - 16px)); background: #FFFFFF; border-radius: 16px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 24px 48px -12px rgb(0 0 0 / .18); display: flex; flex-direction: column; overflow: hidden;")}>
        <div style={st("padding: 20px 24px; display: flex; align-items: flex-start; gap: 12px; border-bottom: 1px solid #EBEBEB;")}>
          <div style={st("flex: 1; display: flex; flex-direction: column; gap: 4px;")}><h2 id="cc-h" style={st(H2)}>Create campaign</h2><p style={st("font-size: 13px; color: #6B6B6B;")}>Terms are written on-chain. There is no edit instruction yet, so choose carefully.</p></div>
          <button className="press gh" type="button" disabled={busy} onClick={onClose} aria-label="Close" style={st("width: 32px; height: 32px; border: 0; background: transparent; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center;")}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333333" strokeWidth="1.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg></button>
        </div>
        <div style={st("flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 20px;")}>
          <fieldset disabled={busy} style={st("border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 12px;")}>
            <legend style={st(LABEL + " padding: 0 0 8px;")}>Service</legend>
            <label style={st("display: flex; flex-direction: column; gap: 6px;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Name</span><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Market brief" style={st(FIELD)} /></label>
            <label style={st("display: flex; flex-direction: column; gap: 6px;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Description</span><textarea value={desc} maxLength={280} rows={2} onChange={(e) => setDesc(e.target.value)} placeholder="What a buyer gets for one call" style={{ ...st(FIELD), height: 64, padding: 12, resize: "vertical" }} /></label>
            <label style={st("display: flex; flex-direction: column; gap: 6px;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Endpoint URL (https)</span><input className="mono" value={url} maxLength={200} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/report" style={{ ...st(FIELD), fontSize: 12 }} /></label>
            <div style={st("display: grid; grid-template-columns: 1fr 1fr; gap: 12px;")}>
              <label style={st("display: flex; flex-direction: column; gap: 6px;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Route</span><input className="mono" value={route} maxLength={80} onChange={(e) => setRoute(e.target.value)} style={{ ...st(FIELD), fontSize: 12 }} /></label>
              <label style={st("display: flex; flex-direction: column; gap: 6px;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Price shown</span><input value={price} maxLength={20} onChange={(e) => setPrice(e.target.value)} style={st(FIELD)} /></label>
            </div>
            <label style={st("display: flex; flex-direction: column; gap: 6px;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Category</span>
              <select value={cat} onChange={(e) => setCat(e.target.value)} style={st(FIELD)}>{Object.entries(CATEGORIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>The price claims must carry comes from your gateway route, not from this field. This text is what people see in the directory.</span>
          </fieldset>
          <div style={st("display: flex; flex-direction: column; gap: 8px;")}>
            <label htmlFor="cc-comm" style={st(LABEL + " display: flex; justify-content: space-between;")}><span>Commission</span><span className="tn" style={st("color: #0F766E;")}>{comm}%</span></label>
            <input id="cc-comm" type="range" min={1} max={50} step={1} value={comm} disabled={busy} onChange={(e) => setComm(Number(e.target.value))} style={st("width: 100%; height: 28px;")} />
            <div className="tn" style={st("display: flex; justify-content: space-between; font-size: 12px; color: #6B6B6B;")}><span>1%</span><span>Maximum: 50%</span><span>50%</span></div>
          </div>
          <div style={st("display: flex; flex-direction: column; gap: 8px;")}>
            <label htmlFor="cc-budget" style={st(LABEL)}>Commission budget (a cap, not escrow)</label>
            <div style={st("display: flex; align-items: center; gap: 12px; background: #F4F4F5; border-radius: 16px; padding: 14px 14px 14px 18px;")}>
              <input id="cc-budget" className="tn" type="text" inputMode="decimal" autoComplete="off" value={budget} disabled={busy} onChange={(e) => setBudget(e.target.value)} style={st("flex: 1; min-width: 0; border: 0; background: transparent; font: 500 28px Inter, sans-serif; letter-spacing: -0.02em; color: #111111; outline-offset: 4px;")} />
              <span style={st("height: 32px; padding: 0 12px; border-radius: 9999px; background: #FFFFFF; box-shadow: 0 0 0 1px rgb(0 0 0 / .06); display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: #111111;")}><span aria-hidden="true" style={st("width: 14px; height: 14px; border-radius: 9999px; background: #0058B0;")} />USDC</span>
            </div>
            <div className="tn" style={st("display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: #6B6B6B;")}><span>Nothing is locked: commission is paid from each sale, up to this cap.</span><span style={st("white-space: nowrap;")}>Covers about {covers.toLocaleString("en-US")} sales</span></div>
          </div>
          <div style={st("display: flex; flex-direction: column; gap: 8px;")}>
            <span id="hold-l" style={st(LABEL)}>Refund hold</span>
            <div role="radiogroup" aria-labelledby="hold-l" style={st("display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; padding: 3px; background: #F4F4F5; border-radius: 10px;")}>
              {[0, 60, 120, 300, 600].map((h) => { const on = hold === h; return <button key={h} type="button" role="radio" aria-checked={on} disabled={busy} onClick={() => setHold(h)} style={st("height: 32px; border: 0; border-radius: 8px; cursor: pointer; font: 500 13px Inter, sans-serif; font-variant-numeric: tabular-nums; " + (on ? "background: #FFFFFF; color: #111111; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .06);" : "background: transparent; color: #6B6B6B;"))}>{h} s</button>; })}
            </div>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>How long you have to refund a failed call before anyone can settle.</span>
          </div>
          <div style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; background: #FAFAFA;")}>
            <span style={st("font-size: 13px; font-weight: 500; color: #111111;")}>On one 0.10 USDC sale</span>
            <div aria-hidden="true" style={st("display: flex; gap: 3px; height: 24px;")}>
              <div className="seg-live" style={{ ...st("flex-basis: 0; background: #111111; border-radius: 6px 3px 3px 6px;"), flexGrow: m }} />
              <div className="seg-live" style={{ ...st("flex-basis: 0; min-width: 3px; background: #0F766E; border-radius: 3px;"), flexGrow: c }} />
              <div style={st("flex: 0 0 6px; background: #D4D4D8; border-radius: 3px 6px 6px 3px;")} />
            </div>
            <dl className="tn" style={st("margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; font-size: 12px;")}>
              <div><dt style={st("color: #6B6B6B;")}>You keep</dt><dd style={st("margin: 0; font-size: 14px; font-weight: 500; color: #111111;")}>{f(m)}</dd></div>
              <div><dt style={st("color: #6B6B6B;")}>Distributor</dt><dd style={st("margin: 0; font-size: 14px; font-weight: 500; color: #0F766E;")}>{f(c)}</dd></div>
              <div><dt style={st("color: #6B6B6B;")}>Protocol fee</dt><dd style={st("margin: 0; font-size: 14px; font-weight: 500; color: #111111;")}>{feeBps === null ? "—" : f(fee)}</dd></div>
            </dl>
            <span style={st("font-size: 12px; color: #6B6B6B;")}>The protocol fee is {feeBps === null ? "set by the program" : `${(feeBps / 100).toFixed(2)}%, set by the program`} (max 5%). You can’t change it or redirect it.</span>
          </div>
          {err && <p role="alert" style={st("font-size: 13px; line-height: 18px; color: #B42318;")}>{err}</p>}
          {busy && <p role="status" style={st("font-size: 13px; color: #333333; display: flex; align-items: center; gap: 8px;")}><svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>{step}</p>}
        </div>
        <div style={st("padding: 16px 24px; border-top: 1px solid #EBEBEB; display: flex; align-items: center; gap: 12px; justify-content: space-between; flex-wrap: wrap;")}>
          <span style={st("font-size: 12px; color: #6B6B6B; max-width: 260px;")}>{w.address ? "You’ll approve one transaction and one listing message in your wallet." : "Connect a wallet to create a campaign."}</span>
          <div style={st("display: flex; gap: 8px;")}>
            <button className="press bs" type="button" disabled={busy} onClick={onClose} style={st("height: 40px; padding: 0 14px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 14px Inter, sans-serif; color: #111111; cursor: pointer;")}>Cancel</button>
            {w.address
              ? <button className="press bp" type="button" disabled={busy} onClick={() => void submit()} style={{ ...st("height: 40px; padding: 0 16px; border: 0; background: #0F766E; border-radius: 10px; font: 500 14px Inter, sans-serif; color: #FFFFFF; cursor: pointer;"), opacity: busy ? 0.6 : 1 }}>Create campaign · {b !== null ? fmt2(b) : "0.00"} USDC cap</button>
              : <WalletButton />}
          </div>
        </div>
      </div>
    </>
  );
}

function RefundDialog({ sale, merchant, onClose, onDone }: { sale: Receipt; merchant: string | null; onClose: () => void; onDone: (r: Receipt) => void }) {
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose, busy]);
  const mine = !!w.address && w.address === merchant;
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      // rent payer is on the sale account on-chain; the API's receipt does not carry it, so read it from the chain here
      const acc = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [sale.sale, { encoding: "base64", commitment: "confirmed" }] }) }).then((r) => r.json());
      const data = Uint8Array.from(atob(acc.result.value.data[0]), (c) => c.charCodeAt(0));
      if (data[244] !== 0) throw new Error("This sale is no longer open, so it can’t be refunded.");
      const rentPayer = new PublicKey(data.slice(104, 136));
      const merchantPk = new PublicKey(w.address!);
      const tx = newTx(refundSaleIx({ merchant: merchantPk, campaign: new PublicKey(sale.campaign), sale: new PublicKey(sale.sale), buyer: new PublicKey(sale.parties.buyer), rentPayer }), merchantPk, await getBlockhash());
      await w.signAndSend(tx);
      onDone(sale);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} style={st("position: fixed; inset: 0; z-index: 50; background: rgb(0 0 0 / .4);")} />
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="rf-h" aria-describedby="rf-d" style={st("position: fixed; z-index: 51; left: 50%; top: 50%; margin-left: max(-240px, -50vw + 8px); margin-top: -110px; width: min(480px, calc(100% - 16px)); background: #FFFFFF; border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 24px 48px -12px rgb(0 0 0 / .18);")}>
        <h2 id="rf-h" style={st(H2)}>Refund this sale?</h2>
        <p id="rf-d" className="tn" style={st("font-size: 14px; line-height: 20px; color: #333333;")}>The buyer gets {fmtAmount(sale.vaultAmount !== "0" ? sale.vaultAmount : sale.gross, sale.decimals)} USDC back and no commission is paid. This counts toward your public refund rate.</p>
        {!w.address && <p style={st("font-size: 12px; line-height: 18px; color: #6B6B6B;")}>Refunds are signed by the merchant wallet. Connect it to continue.</p>}
        {w.address && !mine && <p role="alert" style={st("font-size: 12px; line-height: 18px; color: #B42318;")}>The connected wallet ({short(w.address)}) isn’t this campaign’s merchant. Only the merchant wallet can refund.</p>}
        {err && <p role="alert" style={st("font-size: 13px; color: #B42318;")}>{err}</p>}
        <div style={st("display: flex; gap: 8px; justify-content: flex-end;")}>
          <button className="press bs" type="button" disabled={busy} onClick={onClose} style={st("height: 32px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;")}>Cancel</button>
          {!w.address ? <WalletButton /> : <button className="press bd" type="button" disabled={!mine || busy} onClick={() => void go()} style={{ ...st("height: 32px; padding: 0 12px; border: 0; background: #D92D20; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #FFFFFF; cursor: pointer;"), opacity: !mine || busy ? 0.5 : 1 }}>{busy ? "Refunding…" : "Refund sale"}</button>}
        </div>
      </div>
    </>
  );
}

export default function Merchant() {
  const [sp, setSp] = useSearchParams();
  const [saved, setSaved] = useWalletAddress();
  const w = useWallet();
  const q = sp.get("wallet") ?? "";
  const wallet = isPubkey(q) ? q : (w.address ?? ""); // a pasted address wins; otherwise the connected wallet
  const [toast, setToast] = useState<{ text: string; to?: string } | null>(null);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 8000); return () => clearTimeout(t); }, [toast]);
  const pick = (a: string) => { setSaved(a); setSp({ wallet: a }); };
  const [tab, setTab] = useState<Tab>("all");
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Receipt | null>(null);
  const fresh = useIndexFreshness();
  const now = useNow(1000);

  const list = useApi<ApiPage<Campaign>>(wallet ? "/campaigns?includeUnlisted=1&sort=newest&limit=100" : null);
  const mine = useMemo(() => (list.data?.items ?? []).filter((c) => c.merchant === wallet), [list.data, wallet]);
  const shown = mine.slice(0, MAX_CAMPAIGNS);
  const sales = useMerchantSales(shown.map((c) => c.address));
  const nameOf = (a: string) => mine.find((c) => c.address === a)?.listing?.name ?? short(a);

  const sidebar = (
    <AppSidebar label="Merchant"
      ident={
        <div style={st("height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 8px;")}>
          <span aria-hidden="true" style={st("width: 24px; height: 24px; border-radius: 7px; background: #111111; display: inline-flex; align-items: center; justify-content: center;")}><svg width="14" height="9" viewBox="0 0 24 14"><rect x="0" y="2" width="13" height="10" rx="2.5" fill="#FFFFFF" /><rect x="15" y="2" width="5.5" height="10" rx="2.5" fill="#5EEAD4" /><rect x="22" y="2" width="2" height="10" rx="1" fill="#A1A1AA" /></svg></span>
          <span style={st("flex: 1; display: flex; flex-direction: column;")}><span style={st("font: 500 14px Inter, sans-serif; color: #111111;")}>{wallet === SAMPLE_MERCHANT ? "Sample merchant" : "Merchant"}</span><span style={st("font: 400 12px Inter, sans-serif; color: #6B6B6B;")}>Merchant · devnet</span></span>
        </div>
      }
      nav={[
        { label: "Overview", icon: "M3 12h4l3-8 4 16 3-8h4", current: true, to: wallet ? `/app/merchant?wallet=${wallet}` : "/app/merchant" },
        { label: "Campaigns", icon: "M4 6h16M4 12h16M4 18h10", count: wallet && list.data ? String(mine.length) : undefined },
        { label: "Sales", icon: "M3 3v18h18M7 15l4-4 3 3 5-6", count: sales.items.length ? String(sales.items.length) : undefined },
        { label: "Receipts", icon: "M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6", to: "/receipts" },
        { label: "Budget", icon: "M3 7h18v12H3zM16 13h2M3 7l3-4h12l3 4" },
        { label: "Distributors", icon: "M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" },
        { label: "Settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12h2M18 12h2M12 4v2M12 18v2" },
      ]}
      extra={shown.length > 0 ? (
        <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
          <span style={st("font-size: 12px; font-weight: 500; color: #6B6B6B; padding: 8px 8px 4px;")}>Campaigns</span>
          {shown.slice(0, 5).map((c) => <Link key={c.address} className="nv" to={`/campaigns/${c.address}`} style={st("height: 32px; padding: 0 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; font-size: 14px; color: #333333;")}><Dot color={c.status === "active" ? "#15B042" : "#8A4B00"} /><span style={st("overflow: hidden; text-overflow: ellipsis; white-space: nowrap;")}>{c.listing?.name ?? short(c.address)}</span></Link>)}
        </div>
      ) : undefined}
      footer={
        <div style={st("display: flex; align-items: center; gap: 10px; padding: 8px; border-top: 1px solid #EBEBEB;")}>
          <span aria-hidden="true" style={st("width: 28px; height: 28px; border-radius: 9999px; background: #111111; color: #FFFFFF; font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center;")}>{wallet ? wallet.slice(0, 2) : "—"}</span>
          <span style={st("flex: 1; display: flex; flex-direction: column; min-width: 0;")}><span className="mono" style={st("font-size: 12px; color: #111111;")}>{wallet ? short(wallet) : "No address"}</span></span>
          <DevnetBadge />
        </div>
      }
    />
  );

  const body = (() => {
    if (!wallet) return (
      <>
        <div style={st("display: flex; flex-direction: column; gap: 4px;")}><h1 style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>Overview</h1><p style={st("font-size: 14px; color: #6B6B6B;")}>Sales across your campaigns.</p></div>
        <WalletForm initial={saved} onSubmit={pick} label="Which merchant wallet?" example={{ label: "See the sample merchant", address: SAMPLE_MERCHANT }} />
        <button className="press bp" type="button" onClick={() => setCreating(true)} style={st("align-self: flex-start; height: 32px; padding: 0 12px; border: 0; border-radius: 10px; background: #0F766E; color: #FFFFFF; font: 500 13px Inter, sans-serif; cursor: pointer;")}>Create campaign</button>
      </>
    );
    if (list.loading) return list.waking ? <WakingBanner /> : <p role="status" style={st("font-size: 14px; color: #6B6B6B;")}>Loading campaigns…</p>;
    if (list.error || !list.data) return <ErrorState title="Couldn’t load campaigns" onRetry={list.retry} />;

    const settledSales = sales.items.filter((s) => s.status === "settled");
    const sum = (f: (s: Receipt) => string) => settledSales.reduce((a, s) => a + BigInt(f(s)), 0n);
    const volume = sum((s) => s.gross), comm = sum((s) => s.split.distributor), kept = sum((s) => s.split.merchant), fees = sum((s) => s.split.protocolFee);
    const budgetTotal = shown.reduce((a, c) => a + BigInt(c.budget.total), 0n), budgetLeft = shown.reduce((a, c) => a + BigInt(c.budget.remaining), 0n);
    const settledN = shown.reduce((a, c) => a + c.sales.settled, 0), refundedN = shown.reduce((a, c) => a + c.sales.refunded, 0);
    const closed = settledN + refundedN;
    const dists = new Map<string, { n: number; earned: bigint }>();
    settledSales.forEach((s) => { const d = dists.get(s.parties.distributor) ?? { n: 0, earned: 0n }; d.n++; d.earned += BigInt(s.split.distributor); dists.set(s.parties.distributor, d); });
    const topD = [...dists.entries()].sort((a, b) => (b[1].earned > a[1].earned ? 1 : -1)).slice(0, 5);
    const counts = { all: sales.items.length, open: 0, settled: 0, refunded: 0 };
    sales.items.forEach((s) => counts[s.status]++);
    const rows = tab === "all" ? sales.items : sales.items.filter((s) => s.status === tab);
    const parts = [Number(kept), Number(comm), Number(fees)];
    const allSample = shown.length > 0 && shown.every((c) => c.listing?.isSample);
    const sampleSome = shown.some((c) => c.listing?.isSample);
    const l0 = shown.find((c) => c.listing);

    return (
      <>
        <div style={st("display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between;")}>
          <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
            <h1 style={st("font-size: 20px; line-height: 26px; letter-spacing: -0.015em; font-weight: 500; color: #111111;")}>Overview</h1>
            <p style={st("font-size: 14px; color: #6B6B6B;")}>Sales across {mine.length === 0 ? "your campaigns" : `your ${mine.length} campaign${mine.length === 1 ? "" : "s"}`}{mine.length > MAX_CAMPAIGNS ? ` (showing the ${MAX_CAMPAIGNS} newest)` : ""}.</p>
          </div>
          <button className="press bp" type="button" onClick={() => setCreating(true)} style={st("height: 32px; padding: 0 12px; border: 0; border-radius: 10px; background: #0F766E; color: #FFFFFF; font: 500 13px Inter, sans-serif; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;")}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>Create campaign</button>
        </div>
        <ViewingBar address={wallet} onChange={() => setSp({})} connected={w.address} />

        {sampleSome && (
          <div role="note" style={st("display: flex; gap: 10px; align-items: center; padding: 10px 14px; border: 1px solid #EBEBEB; border-radius: 10px; background: #FAFAFA; font-size: 13px; color: #333333;")}>
            <SampleBadge style={{ border: "1px solid #EBEBEB" }} />
            <span>{allSample ? "These campaigns sell Noux sample services." : "Some of these campaigns sell Noux sample services."} Sales came from team test wallets on devnet.</span>
          </div>
        )}

        {mine.length === 0 ? (
          <div style={st("display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 56px 24px; border: 1px dashed #D4D4D8; border-radius: 12px;")}>
            <h2 style={st("font-size: 16px; font-weight: 500; color: #111111;")}>No campaigns for this wallet</h2>
            <p style={st("font-size: 14px; color: #6B6B6B; max-width: 380px;")}>The index has no campaign created by <span className="mono">{short(wallet)}</span>. It may be brand new (the index runs about every 20 s).</p>
          </div>
        ) : (
          <>
            <section aria-label="Key numbers" style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px;")}>
              {[
                ["Settled volume", <>{fmt2(volume)} <span style={st("font-size: 14px; color: #6B6B6B; font-weight: 400;")}>USDC</span></>, <>{settledN} settled sale{settledN === 1 ? "" : "s"}</>],
                ["Commission paid", <>{fmtShort(comm)} <span style={st("font-size: 14px; color: #6B6B6B; font-weight: 400;")}>USDC</span></>, <>To {dists.size} distributor{dists.size === 1 ? "" : "s"}</>],
                ["Commission budget left (cap)", <>{fmt2(budgetLeft)} <span style={st("font-size: 14px; color: #6B6B6B; font-weight: 400;")}>USDC</span></>, <>{fmt2(budgetTotal - budgetLeft)} of {fmt2(budgetTotal)} USDC used</>],
                ["Refund rate", <>{closed ? ((refundedN / closed) * 100).toFixed(1) : "—"}<span style={st("font-size: 14px; color: #6B6B6B; font-weight: 400;")}>{closed ? "%" : ""}</span></>, <>{refundedN} of {closed} closed sales · shown publicly</>],
              ].map(([k, v, n]) => (
                <div key={k as string} style={st("border: 1px solid #EBEBEB; border-radius: 12px; display: flex; flex-direction: column;")}>
                  <div style={st("padding: 16px; display: flex; flex-direction: column; gap: 6px;")}><span style={st("font-size: 13px; color: #6B6B6B;")}>{k}</span><span className="tn" style={st("font-size: 32px; line-height: 36px; letter-spacing: -0.025em; font-weight: 500; color: #111111;")}>{v}</span></div>
                  <div className="tn" style={st("border-top: 1px solid #EBEBEB; padding: 10px 16px; font-size: 12px; color: #6B6B6B;")}>{n}</div>
                </div>
              ))}
            </section>

            {volume > 0n && (
              <section aria-labelledby="w-h" style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 14px;")}>
                <div style={st("display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline;")}><h2 id="w-h" style={st(H2)}>Where {fmt2(volume)} USDC went</h2><span style={st("font-size: 12px; color: #6B6B6B;")}>Settled sales{sales.items.length >= 100 ? " (latest 100 per campaign)" : ""}</span></div>
                <div aria-hidden="true" style={st("display: flex; gap: 4px; height: 12px;")}><div style={{ ...st("background: #111111; border-radius: 6px 3px 3px 6px;"), flex: parts[0] }} /><div style={{ ...st("background: #0F766E; border-radius: 3px;"), flex: parts[1] }} /><div style={{ ...st("background: #D4D4D8; border-radius: 3px 6px 6px 3px;"), flex: `0 0 ${Math.max(6, (parts[2] / Number(volume)) * 100)}%` }} /></div>
                <dl className="tn" style={st("margin: 0; display: flex; flex-wrap: wrap; gap: 12px 40px; font-size: 13px;")}>
                  {[["You kept", "#111111", "#111111", kept], ["Distributors", "#0F766E", "#0F766E", comm], ["Protocol fee", "#D4D4D8", "#111111", fees]].map(([k, sw, fg, v]) => (
                    <div key={k as string} style={st("display: flex; align-items: center; gap: 8px;")}><span aria-hidden="true" style={{ ...st("width: 10px; height: 6px; border-radius: 2px;"), background: sw as string }} /><dt style={st("color: #6B6B6B;")}>{k as string}</dt><dd style={{ ...st("margin: 0; font-weight: 500;"), color: fg as string }}>{fmtAmount(v as bigint)} USDC</dd></div>
                  ))}
                </dl>
              </section>
            )}

            <div style={st("display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start;")}>
              <section aria-labelledby="s-h" style={st("flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 12px;")}>
                <div style={st("display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;")}>
                  <h2 id="s-h" style={st(H2)}>Sales</h2>
                  <div role="tablist" aria-label="Filter sales" style={st("display: flex; gap: 0; border-bottom: 1px solid #EBEBEB;")}>
                    {([["all", "All"], ["open", "Held"], ["settled", "Settled"], ["refunded", "Refunded"]] as [Tab, string][]).map(([id, label]) => {
                      const on = tab === id;
                      return <button key={id} type="button" role="tab" aria-selected={on} onClick={() => setTab(id)} style={st("height: 32px; padding: 0 12px; border: 0; background: transparent; cursor: pointer; font: 500 13px Inter, sans-serif; margin-bottom: -1px; border-bottom: 2px solid " + (on ? "#111111" : "transparent") + "; color: " + (on ? "#111111" : "#6B6B6B") + ";")}>{label} <span className="tn" style={st("color: #6B6B6B; font-weight: 400;")}>{counts[id]}</span></button>;
                    })}
                  </div>
                </div>
                <div style={st("border: 1px solid #EBEBEB; border-radius: 12px; overflow-x: auto;")}>
                  {sales.loading ? <p role="status" style={st("padding: 24px; font-size: 13px; color: #6B6B6B;")}>Loading sales…</p> : sales.error ? <p role="alert" style={st("padding: 24px; font-size: 13px; color: #B42318;")}>Couldn’t load sales.</p> : rows.length > 0 ? (
                    <table style={st("width: 100%; min-width: 760px; border-collapse: collapse; font-size: 14px;")}>
                      <thead><tr style={st("height: 40px; text-align: left;")}>
                        {[["Sale", "padding: 0 12px 0 16px;"], ["Service", "padding: 0 12px;"], ["Distributor", "padding: 0 12px;"], ["Status", "padding: 0 12px;"], ["Paid", "padding: 0 12px; text-align: right;"], ["Commission", "padding: 0 12px; text-align: right;"], ["", "padding: 0 16px 0 12px; width: 112px;"]].map(([h, s], i) => <th key={i} scope="col" style={st("font-size: 12px; font-weight: 500; color: #6B6B6B; border-bottom: 1px solid #EBEBEB; " + s)}>{h || <span className="vh">Actions</span>}</th>)}
                      </tr></thead>
                      <tbody>
                        {rows.slice(0, 25).map((r) => {
                          const left = r.status === "open" && r.holdUntil ? (new Date(r.holdUntil).getTime() - now) / 1000 : 0;
                          return (
                            <tr key={r.sale} className="rh" style={st("height: 44px;")}>
                              <td style={st("padding: 0 12px 0 16px; border-bottom: 1px solid #EBEBEB; white-space: nowrap;")}><Link className="mono" to={`/r/${r.sale}`} style={st("font-size: 12px;")}>{short(r.sale)}</Link><span className="tn" style={st("font-size: 12px; color: #6B6B6B; margin-left: 8px;")}>{dayTime(r.settledAt ?? r.openedAt)}</span></td>
                              <td style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB; color: #111111; white-space: nowrap;")}>{nameOf(r.campaign)}</td>
                              <td className="mono" style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB; font-size: 12px; color: #333333; white-space: nowrap;")}>{short(r.parties.distributor)}</td>
                              <td style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB;")}><SaleBadge status={r.status} text={r.status === "open" ? openText(r, left) : undefined} /></td>
                              <td className="tn" style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB; text-align: right; color: #111111;")}>{fmtAmount(r.status === "open" ? r.vaultAmount : r.gross, r.decimals)}</td>
                              <td className="tn" style={st("padding: 0 12px; border-bottom: 1px solid #EBEBEB; text-align: right; color: #111111;")}>{r.status === "refunded" ? "—" : fmtAmount(r.split.distributor, r.decimals)}</td>
                              <td style={st("padding: 0 16px 0 12px; border-bottom: 1px solid #EBEBEB; text-align: right;")}>
                                {r.status === "open" && r.funded && <button className="press bs ra" type="button" onClick={() => setConfirm(r)} style={st("opacity: 0; height: 24px; padding: 0 8px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 6px; font: 500 12px Inter, sans-serif; color: #111111; cursor: pointer; transition: opacity 150ms;")}>Refund sale</button>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div className="fadein" style={st("padding: 56px 24px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px;")}>
                      <div style={st("width: 40px; height: 40px; border-radius: 12px; background: #F4F4F5; display: flex; align-items: center; justify-content: center;")}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333333" strokeWidth="1.5" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg></div>
                      <h3 style={st("font-size: 16px; font-weight: 500; color: #111111;")}>{tab === "refunded" ? "No refunds" : "No sales"}</h3>
                      <p style={st("font-size: 14px; color: #6B6B6B; max-width: 360px;")}>{tab === "refunded" ? "You haven’t refunded a sale. Refunds are only possible while a sale is held, before it settles." : "Nothing in this view yet."}</p>
                    </div>
                  )}
                </div>
                <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>{rows.length ? `1–${Math.min(25, rows.length)} of ${rows.length} sales` : ""}</span>
              </section>

              <aside style={st("flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 12px;")}>
                <section aria-labelledby="i-h" style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px;")}>
                  <h2 id="i-h" style={st(H2)}>Integration</h2>
                  <ul style={st("list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; font-size: 13px;")}>
                    <li style={st("display: flex; justify-content: space-between; gap: 8px; padding: 8px 0;")}><span style={st("display: flex; align-items: center; gap: 8px; color: #333333;")}><Dot color={l0 ? "#15B042" : "#8A8A8A"} />Listing</span><span style={st("color: #6B6B6B;")}>{l0 ? "Signed · in directory" : "Not listed"}</span></li>
                  </ul>
                  <pre className="mono" style={st("margin: 0; padding: 12px; background: #FAFAFA; border: 1px solid #EBEBEB; border-radius: 8px; font-size: 11px; line-height: 17px; color: #333333; overflow-x: auto;")}>{`app.use("/v1/brief", nouxGateway({\n  campaign: "${short(shown[0]?.address ?? "campaign")}",\n  price: "0.10",\n}));`}</pre>
                  <Link to="/docs/quickstart" style={st("font-size: 13px; font-weight: 500;")}>Gateway docs →</Link>
                </section>
                <section aria-labelledby="td-h" style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px;")}>
                  <h2 id="td-h" style={st(H2)}>Top distributors</h2>
                  {topD.length === 0 ? <p style={st("font-size: 13px; color: #6B6B6B;")}>None yet.</p> : topD.map(([a, v], i) => (
                    <div key={a} className="tn" style={st("display: flex; justify-content: space-between; align-items: center; height: 36px; font-size: 13px; " + (i < topD.length - 1 ? "border-bottom: 1px solid #EBEBEB;" : ""))}><span className="mono" style={st("font-size: 12px; color: #333333;")}>{short(a)}</span><span style={st("color: #111111;")}>{v.n} sale{v.n === 1 ? "" : "s"} · {fmtShort(v.earned)}</span></div>
                  ))}
                </section>
              </aside>
            </div>
          </>
        )}
      </>
    );
  })();

  return (
    <div style={st("display: flex; flex-wrap: wrap; min-height: 100vh; background: #FFFFFF;")}>
      {sidebar}
      <div style={st("flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column;")}>
        <header style={st("height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 clamp(16px, 3vw, 32px); border-bottom: 1px solid #EBEBEB;")}>
          <NavMenu />
          <nav aria-label="Breadcrumb" style={st("font-size: 13px; color: #6B6B6B; display: flex; gap: 8px;")}><Link to="/" style={st("color: #6B6B6B;")}>Noux</Link><span aria-hidden="true">/</span><span style={st("color: #111111;")}>Merchant overview</span></nav>
          <span style={{ flex: 1 }} />
          <Freshness ageSeconds={fresh.info?.ageSeconds} fetchedAt={fresh.fetchedAt} now={fresh.now} error={fresh.error} />
          <WalletButton compact />
        </header>
        <main style={st("padding: 28px clamp(16px, 3vw, 32px) 64px; display: flex; flex-direction: column; gap: 28px; max-width: 1240px; width: 100%;")}>{body}</main>
      </div>
      {creating && <CreateSheet onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); list.retry(); setToast({ text: "Campaign created and listed. The directory updates within a minute.", to: `/campaigns/${c}` }); }} />}
      {confirm && <RefundDialog sale={confirm} merchant={mine.find((c) => c.address === confirm.campaign)?.merchant ?? null} onClose={() => setConfirm(null)} onDone={(r) => { setConfirm(null); list.retry(); setToast({ text: `Sale refunded. The buyer has ${fmtAmount(r.vaultAmount !== "0" ? r.vaultAmount : r.gross, r.decimals)} USDC back.`, to: `/r/${r.sale}` }); }} />}
      {toast && (
        <div className="toast" role="status" style={st("position: fixed; z-index: 70; right: 24px; bottom: 24px; max-width: calc(100% - 48px); background: #111111; color: #FFFFFF; border-radius: 12px; padding: 12px 16px; font-size: 14px; display: flex; align-items: center; gap: 12px; box-shadow: 0 12px 24px -8px rgb(0 0 0 / .3);")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5EEAD4" strokeWidth="2" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
          <span>{toast.text}</span>
          {toast.to && <Link to={toast.to} style={st("color: #5EEAD4; font: 500 13px Inter, sans-serif;")}>View</Link>}
          <button type="button" onClick={() => setToast(null)} style={st("border: 0; background: none; color: #A1A1AA; font: 500 13px Inter, sans-serif; cursor: pointer; padding: 4px;")}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
