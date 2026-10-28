import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { st } from "../lib/css";
import { isPubkey } from "../lib/wallet";
import { short } from "../lib/format";

export interface NavItem { label: string; icon: string; count?: string; to?: string; current?: boolean }

const NAV_ITEM = "height: 32px; padding: 0 8px; border-radius: 8px; display: flex; align-items: center; gap: 10px; font-size: 14px; ";

export function AppSidebar({ ident, nav, extra, footer, label }: { ident: ReactNode; nav: NavItem[]; extra?: ReactNode; footer: ReactNode; label: string }) {
  return (
    <aside aria-label="App" style={st("flex: 1 1 240px; max-width: 100%; background: #FAFAFA; border-right: 1px solid #EBEBEB; padding: 12px; display: flex; flex-direction: column; gap: 16px;")}>
      {ident}
      <nav aria-label={label} style={st("display: flex; flex-direction: column; gap: 2px;")}>
        {nav.map((n) => {
          const inner = (
            <>
              <span style={st("display: inline-flex; width: 16px; height: 16px;")} aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={n.icon} /></svg></span>
              {n.label}<span style={{ flex: 1 }} />
              {n.count && <span className="tn" style={st("font-size: 12px; color: #6B6B6B;")}>{n.count}</span>}
            </>
          );
          const cur = n.current ? "background: #F4F4F5; color: #111111; font-weight: 500;" : "color: #333333;";
          if (n.to) return <Link key={n.label} className="nv" to={n.to} aria-current={n.current ? "page" : undefined} style={st(NAV_ITEM + cur)}>{inner}</Link>;
          return <span key={n.label} aria-disabled="true" title="Coming soon" style={st(NAV_ITEM + "color: #6B6B6B;")}>{inner}</span>;
        })}
      </nav>
      {extra}
      <div style={{ flex: 1 }} />
      {footer}
    </aside>
  );
}

/** Wallet address entry. There is no wallet connection yet: this only chooses whose public numbers to read. */
export function WalletForm({ initial, onSubmit, label, example, onCancel, cancelLabel, onBack }: { initial: string; onSubmit: (a: string) => void; label: string; example?: { label: string; address: string }; onCancel?: () => void; cancelLabel?: string; onBack?: () => void }) {
  const [v, setV] = useState(initial);
  const ok = isPubkey(v);
  const go = (e: FormEvent) => { e.preventDefault(); if (ok) onSubmit(v); };
  return (
    <form onSubmit={go} style={st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 12px; max-width: 640px;")}>
      {onBack && <button type="button" onClick={onBack} className="press gh" style={st("align-self: flex-start; height: 28px; margin: -6px 0 0 -8px; padding: 0 10px 0 6px; border: 0; background: transparent; border-radius: 8px; color: #333333; font: 500 13px Inter, sans-serif; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>Back</button>}
      <label htmlFor="wallet-in" style={st("font-size: 14px; font-weight: 500; color: #111111;")}>{label}</label>
      <div style={st("display: flex; gap: 8px; flex-wrap: wrap;")}>
        <input id="wallet-in" className="mono" spellCheck={false} autoComplete="off" placeholder="Paste a Solana wallet address" value={v} onChange={(e) => setV(e.target.value.trim())} aria-invalid={v !== "" && !ok}
          style={st("flex: 1 1 280px; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid " + (v !== "" && !ok ? "#D92D20" : "#8A8A8A") + "; border-radius: 8px; font-size: 12px; color: #111111; background: #FFFFFF;")} />
        <button className="press bp" type="submit" disabled={!ok} style={{ ...st("height: 40px; padding: 0 16px; border: 0; background: #0F766E; border-radius: 10px; font: 500 14px Inter, sans-serif; color: #FFFFFF; cursor: pointer;"), opacity: ok ? 1 : 0.5 }}>View</button>
      </div>
      {v !== "" && !ok && <span style={st("font-size: 12px; color: #B42318;")}>That doesn’t look like a Solana address.</span>}
      <p style={st("font-size: 12px; line-height: 18px; color: #6B6B6B;")}>Connect a wallet (top right) to act as that wallet, or paste any address to read its public on-chain numbers. Pasting an address can’t sign anything.</p>
      {onCancel && <button type="button" onClick={onCancel} style={st("align-self: flex-start; border: 0; background: none; padding: 0; color: #0F766E; font: 500 13px Inter, sans-serif; cursor: pointer;")}>{cancelLabel ?? "Cancel"}</button>}
      {example && <button type="button" onClick={() => onSubmit(example.address)} style={st("align-self: flex-start; border: 0; background: none; padding: 0; color: #0F766E; font: 500 13px Inter, sans-serif; cursor: pointer;")}>{example.label} ({short(example.address)}) →</button>}
    </form>
  );
}

export function ViewingBar({ address, onChange, connected }: { address: string; onChange: () => void; connected?: string | null }) {
  return (
    <div role="note" style={st("display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 14px; border: 1px solid #EBEBEB; border-radius: 10px; background: #FAFAFA; font-size: 13px; color: #333333;")}>
      <span>Showing the public numbers for <span className="mono" title={address} style={st("font-size: 12px;")}>{short(address)}</span>.{connected === address ? " This is your connected wallet." : connected ? " This isn’t your connected wallet, so you can’t act for it." : " Connect a wallet to act for it."}</span>
      <button type="button" onClick={onChange} style={st("border: 0; background: none; padding: 0; color: #0F766E; font: 500 13px Inter, sans-serif; cursor: pointer;")}>Change address</button>
    </div>
  );
}
