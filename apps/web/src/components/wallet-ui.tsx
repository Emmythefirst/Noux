import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { st } from "../lib/css";
import { short } from "../lib/format";
import { useWallet } from "../lib/wallet-connect";

export function WalletModal({ onClose }: { onClose: () => void }) {
  const { wallets, connect, connecting, error, address } = useWallet();
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  useEffect(() => { if (address) onClose(); }, [address, onClose]);
  // Portal to <body>: the sticky header uses backdrop-filter, which makes `position: fixed` children relative to the header instead of the screen.
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} style={st("position: fixed; inset: 0; z-index: 60; background: rgb(0 0 0 / .4);")} />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="wm-h" style={st("position: fixed; z-index: 61; left: 50%; top: 50%; margin-left: max(-200px, -50vw + 8px); margin-top: -160px; width: min(400px, calc(100% - 16px)); background: #FFFFFF; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 24px 48px -12px rgb(0 0 0 / .18);")}>
        <div style={st("display: flex; align-items: center; gap: 8px;")}>
          <h2 id="wm-h" style={st("flex: 1; font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;")}>Connect a wallet</h2>
          <button className="press gh" type="button" onClick={onClose} aria-label="Close" style={st("width: 28px; height: 28px; border: 0; background: transparent; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center;")}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333333" strokeWidth="1.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg></button>
        </div>
        {wallets.length === 0 ? (
          <p style={st("font-size: 14px; line-height: 20px; color: #333333;")}>No Solana wallet was detected in this browser. Install one (for example Phantom or Solflare), reload this page and try again. Set the wallet to devnet.</p>
        ) : (
          <ul style={st("list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px;")}>
            {wallets.map((w) => (
              <li key={w.name}>
                <button className="press bs" type="button" disabled={connecting} onClick={() => void connect(w)} style={st("width: 100%; height: 48px; padding: 0 12px; display: flex; align-items: center; gap: 12px; border: 1px solid #EBEBEB; border-radius: 12px; background: #FFFFFF; cursor: pointer; font: 500 14px Inter, sans-serif; color: #111111; text-align: left;")}>
                  {w.icon ? <img src={w.icon} alt="" width={24} height={24} style={{ borderRadius: 6 }} /> : <span aria-hidden="true" style={st("width: 24px; height: 24px; border-radius: 6px; background: #F4F4F5;")} />}
                  <span style={{ flex: 1 }}>{w.name}</span>
                  {connecting && <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert" style={st("font-size: 13px; color: #B42318;")}>{error}</p>}
        <p style={st("font-size: 12px; line-height: 18px; color: #6B6B6B;")}>Noux never sees your keys. Your wallet asks you to approve every transaction and message. This is devnet: nothing here moves real money.</p>
      </div>
    </>,
    document.body,
  );
}

/** The design's wallet pill; "Connect wallet" when nothing is connected. */
export function WalletButton({ compact = false, align = "right", dropUp = false }: { compact?: boolean; align?: "left" | "right"; dropUp?: boolean }) {
  const { address, walletName, disconnect } = useWallet();
  const [modal, setModal] = useState(false);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const d = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", d); return () => document.removeEventListener("mousedown", d);
  }, [menu]);
  if (!address) return (
    <>
      <button className="press bi" type="button" onClick={() => setModal(true)} style={st("height: 36px; padding: 0 14px; border: 0; border-radius: 9999px; background: #111111; color: #FFFFFF; font: 500 13px Inter, sans-serif; cursor: pointer; white-space: nowrap;")}>{compact ? "Connect" : "Connect wallet"}</button>
      {modal && <WalletModal onClose={() => setModal(false)} />}
    </>
  );
  return (
    <div ref={ref} style={st("position: relative;")}>
      <button className="press bs" type="button" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} style={st("height: 36px; padding: 0 14px 0 6px; border-radius: 9999px; border: 1px solid #EBEBEB; background: #FFFFFF; display: inline-flex; align-items: center; gap: 8px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;")}>
        <span aria-hidden="true" style={st("width: 24px; height: 24px; border-radius: 9999px; background: #0F766E; color: #FFFFFF; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600;")}>{address.slice(0, 2)}</span>
        <span className="mono" style={st("font-size: 12px;")}>{short(address)}</span>
      </button>
      {menu && (
        <div role="menu" className="fadein" style={{ ...(align === "left" ? { left: 0 } : { right: 0 }), ...(dropUp ? { bottom: 42 } : { top: 42 }), ...st("position: absolute; z-index: 40; min-width: 200px; background: #FFFFFF; border-radius: 12px; padding: 6px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 12px 24px -8px rgb(0 0 0 / .18);") }}>
          <div style={st("padding: 8px 10px; font-size: 12px; color: #6B6B6B;")}>Connected with {walletName}</div>
          <button role="menuitem" className="press gh" type="button" onClick={() => { setMenu(false); void disconnect(); }} style={st("width: 100%; height: 32px; padding: 0 10px; border: 0; background: transparent; border-radius: 8px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer; text-align: left;")}>Disconnect</button>
        </div>
      )}
    </div>
  );
}
