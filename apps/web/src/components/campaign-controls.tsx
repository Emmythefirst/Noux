import { useEffect, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { st } from "../lib/css";
import { apiGet, type Campaign } from "../lib/api";
import { fmt2, short } from "../lib/format";
import { newTx, parseAmount, setAttributionKeyIx, setCampaignStateIx, topUpBudgetIx, type CampaignStateName } from "../lib/program";
import { getBlockhash, useWallet } from "../lib/wallet-connect";
import { isPubkey } from "../lib/wallet";
import { WalletButton } from "./wallet-ui";

const H2 = "font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;";
const FIELD = "height: 40px; padding: 0 12px; border: 1px solid #8A8A8A; border-radius: 8px; font: 400 14px Inter, sans-serif; color: #111111; background: #FFFFFF; width: 100%;";
const BTN = "height: 32px; padding: 0 12px; border-radius: 10px; font: 500 13px Inter, sans-serif; cursor: pointer;";

function Shell({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose, busy]);
  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} style={st("position: fixed; inset: 0; z-index: 50; background: rgb(0 0 0 / .4);")} />
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={st("position: fixed; z-index: 51; left: 0; right: 0; top: 50%; transform: translateY(-50%); margin: 0 auto; width: min(480px, calc(100% - 16px)); max-height: calc(100vh - 16px); overflow: auto; background: #FFFFFF; border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 24px 48px -12px rgb(0 0 0 / .18);")}>
        <h2 style={st(H2)}>{title}</h2>
        {children}
      </div>
    </>
  );
}

function Actions({ w, mine, busy, ok, label, onClose, onGo }: { w: ReturnType<typeof useWallet>; mine: boolean; busy: boolean; ok: boolean; label: string; onClose: () => void; onGo: () => void }) {
  return (
    <div style={st("display: flex; gap: 8px; justify-content: flex-end;")}>
      <button className="press bs tap" type="button" disabled={busy} onClick={onClose} style={{ ...st(BTN + "border: 1px solid #D4D4D8; background: #FFFFFF; color: #111111;") }}>Cancel</button>
      {!w.address ? <WalletButton /> : <button className="press bp tap" type="button" disabled={!mine || !ok || busy} onClick={onGo} style={{ ...st(BTN + "border: 0; background: #0F766E; color: #FFFFFF;"), opacity: !mine || !ok || busy ? 0.5 : 1 }}>{busy ? "Working…" : label}</button>}
    </div>
  );
}
const NotMine = ({ addr }: { addr: string }) => <p role="alert" style={st("font-size: 12px; line-height: 18px; color: #B42318;")}>The connected wallet ({short(addr)}) isn’t this campaign’s merchant. Only the merchant wallet can change it.</p>;

/** Raise the commission budget (the cap). Increase-only; no funds move. */
export function TopUpDialog({ campaign, onClose, onDone }: { campaign: Campaign; onClose: () => void; onDone: (text: string) => void }) {
  const w = useWallet(); const [v, setV] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const mine = !!w.address && w.address === campaign.merchant;
  let amount: bigint | null = null; try { if (v.trim()) { const a = parseAmount(v.trim(), campaign.decimals); if (a > 0n && a < 1n << 63n) amount = a; } } catch { /* shown as not ok */ }
  const total = BigInt(campaign.budget.total), after = amount !== null ? total + amount : null;
  const go = async () => {
    if (amount === null || !w.address) return; setBusy(true); setErr(null);
    try { const m = new PublicKey(w.address); await w.signAndSend(newTx(topUpBudgetIx({ merchant: m, campaign: new PublicKey(campaign.address), amount }), m, await getBlockhash())); onDone(`Budget raised by ${v.trim()} USDC. The page catches up within a minute.`); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Shell title="Add commission budget" busy={busy} onClose={onClose}>
      <p style={st("font-size: 14px; line-height: 20px; color: #333333;")}>The budget is a cap on the commission this campaign can pay out, not money held by Noux. Adding to it moves no funds; it only raises how much you are willing to pay distributors. It can only go up.</p>
      <label style={st("display: flex; flex-direction: column; gap: 6px; font: 500 13px Inter, sans-serif; color: #333333;")}>Amount to add (USDC)
        <input inputMode="decimal" autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="5.00" style={st(FIELD)} />
      </label>
      <p className="tn" style={st("font-size: 13px; color: #6B6B6B;")}>Now {fmt2(total, campaign.decimals)} USDC{after !== null ? ` → ${fmt2(after, campaign.decimals)} USDC after` : ""}. Already paid out: {fmt2(BigInt(campaign.budget.spent), campaign.decimals)}.</p>
      {!w.address && <p style={st("font-size: 12px; line-height: 18px; color: #6B6B6B;")}>This is signed by the merchant wallet. Connect it to continue.</p>}
      {w.address && !mine && <NotMine addr={w.address} />}
      {err && <p role="alert" style={st("font-size: 13px; color: #B42318;")}>{err}</p>}
      <Actions w={w} mine={mine} busy={busy} ok={amount !== null} label="Add budget" onClose={onClose} onGo={() => void go()} />
    </Shell>
  );
}

/** Change which key the campaign trusts to sign claims. Takes effect at once. */
export function RotateKeyDialog({ campaign, onClose, onDone }: { campaign: Campaign; onClose: () => void; onDone: (text: string) => void }) {
  const w = useWallet(); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [svcKey, setSvcKey] = useState<string | null>(null); const [retiring, setRetiring] = useState<string[]>([]); const [v, setV] = useState("");
  useEffect(() => { let live = true; apiGet<{ attributionKey: string; retiringKeys?: string[] }>("/claim-service").then((s) => { if (live) { setSvcKey(s.attributionKey); setRetiring(s.retiringKeys ?? []); setV((cur) => cur || s.attributionKey); } }).catch(() => {}); return () => { live = false; }; }, []);
  const mine = !!w.address && w.address === campaign.merchant;
  const valid = isPubkey(v.trim()) && v.trim() !== "11111111111111111111111111111111" && v.trim() !== campaign.attributionKey;
  const go = async () => {
    if (!valid || !w.address) return; setBusy(true); setErr(null);
    try { const m = new PublicKey(w.address); await w.signAndSend(newTx(setAttributionKeyIx({ merchant: m, campaign: new PublicKey(campaign.address), newKey: new PublicKey(v.trim()) }), m, await getBlockhash())); onDone("Claim key changed. Claims signed by the old key stop working now; sales already open settle normally."); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Shell title="Change the claim key" busy={busy} onClose={onClose}>
      <p style={st("font-size: 14px; line-height: 20px; color: #333333;")}>Every referral claim for this campaign is signed by one key, and the program only accepts claims signed by the key stored here. Change it if you think the current one has leaked, or to move to a new Noux claim key. It takes effect immediately: claims signed by the old key stop working, buyers simply ask for a new one, and sales already open still settle.</p>
      {campaign.attributionKey && retiring.includes(campaign.attributionKey) && <p role="status" style={st("font-size: 13px; line-height: 19px; color: #8A4B00; background: #FFF1D6; border-radius: 8px; padding: 10px 12px;")}>Noux is retiring the key this campaign trusts. It still works for now, but switch to the current Noux key below before it is removed.</p>}
      <div className="tn" style={st("font-size: 12px; line-height: 18px; color: #6B6B6B; display: flex; flex-direction: column; gap: 2px;")}>
        <span>This campaign trusts now: <span className="mono">{campaign.attributionKey ? short(campaign.attributionKey) : "unknown"}</span></span>
        <span>The Noux claim service signs with: <span className="mono">{svcKey ? short(svcKey) : "…"}</span>{svcKey && campaign.attributionKey === svcKey ? " (the same)" : ""}</span>
      </div>
      <label style={st("display: flex; flex-direction: column; gap: 6px; font: 500 13px Inter, sans-serif; color: #333333;")}>New claim key (a Solana public key)
        <input value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} className="mono" style={st(FIELD + "font-size: 13px;")} />
      </label>
      <p style={st("font-size: 12px; line-height: 18px; color: #8A4B00; background: #FFF1D6; border-radius: 8px; padding: 8px 10px;")}>Only use a key whose owner you trust. If nobody holds the private key, no referral claim can be issued for this campaign (buyers can still buy without a referral).</p>
      {v.trim() !== "" && !valid && <p role="alert" style={st("font-size: 12px; color: #B42318;")}>{v.trim() === campaign.attributionKey ? "That is the key the campaign already trusts." : "Enter a valid Solana public key."}</p>}
      {w.address && !mine && <NotMine addr={w.address} />}
      {err && <p role="alert" style={st("font-size: 13px; color: #B42318;")}>{err}</p>}
      <Actions w={w} mine={mine} busy={busy} ok={valid} label="Change key" onClose={onClose} onGo={() => void go()} />
    </Shell>
  );
}

const STATE_COPY = {
  pause: { title: "Pause promotions", go: "Pause promotions", to: "paused" as CampaignStateName, done: "Promotions paused. No new referral sales; buyers can still buy without a referral.",
    body: "Pausing stops NEW referral sales on this campaign right away. Buyers can still buy from you without a referral and you are paid in full. Sales that are already open settle normally and can still be refunded. You can resume whenever you like. The first pause creates a small on-chain record (under 0.002 SOL, paid by your wallet)." },
  resume: { title: "Resume promotions", go: "Resume promotions", to: "active" as CampaignStateName, done: "Promotions resumed. New referral sales are open again.",
    body: "Referral sales start again straight away." },
  end: { title: "End this campaign", go: "End campaign for good", to: "ended" as CampaignStateName, done: "Campaign ended. It takes no new referral sales and can never be reopened.",
    body: "Ending is permanent. The campaign takes no new referral sales and can never be resumed or paused again. Sales already open still settle, past receipts stay public and verifiable, and you can still raise the budget or change the claim key. If you want to promote this service again, create a new campaign." },
};

/** Pause, resume or permanently end a campaign's new referral sales. */
export function StateDialog({ campaign, action, onClose, onDone }: { campaign: Campaign; action: keyof typeof STATE_COPY; onClose: () => void; onDone: (text: string, state: CampaignStateName) => void }) {
  const w = useWallet(); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [typed, setTyped] = useState("");
  const copy = STATE_COPY[action], mine = !!w.address && w.address === campaign.merchant, ok = action !== "end" || typed.trim().toUpperCase() === "END";
  const go = async () => {
    if (!w.address || !ok) return; setBusy(true); setErr(null);
    try { const m = new PublicKey(w.address); await w.signAndSend(newTx(setCampaignStateIx({ merchant: m, campaign: new PublicKey(campaign.address), state: copy.to }), m, await getBlockhash())); onDone(copy.done, copy.to); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Shell title={copy.title} busy={busy} onClose={onClose}>
      <p style={st("font-size: 14px; line-height: 20px; color: #333333;")}>{copy.body}</p>
      {action === "end" && (
        <label style={st("display: flex; flex-direction: column; gap: 6px; font: 500 13px Inter, sans-serif; color: #333333;")}>Type END to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder="END" style={st(FIELD)} />
        </label>
      )}
      {!w.address && <p style={st("font-size: 12px; line-height: 18px; color: #6B6B6B;")}>This is signed by the merchant wallet. Connect it to continue.</p>}
      {w.address && !mine && <NotMine addr={w.address} />}
      {err && <p role="alert" style={st("font-size: 13px; color: #B42318;")}>{err}</p>}
      <div style={st("display: flex; gap: 8px; justify-content: flex-end;")}>
        <button className="press bs tap" type="button" disabled={busy} onClick={onClose} style={st(BTN + "border: 1px solid #D4D4D8; background: #FFFFFF; color: #111111;")}>Cancel</button>
        {!w.address ? <WalletButton /> : <button className="press tap" type="button" disabled={!mine || !ok || busy} onClick={() => void go()} style={{ ...st(BTN + "border: 0; color: #FFFFFF; background: " + (action === "end" ? "#D92D20;" : "#0F766E;")), opacity: !mine || !ok || busy ? 0.5 : 1 }}>{busy ? "Working…" : copy.go}</button>}
      </div>
    </Shell>
  );
}
