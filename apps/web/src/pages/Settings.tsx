import { st } from "../lib/css";
import { API_BASE } from "../lib/api";
import { short } from "../lib/format";
import { PROGRAM_ID, USDC_MINT } from "../lib/program";
import { RPC_URL } from "../lib/verify";
import { useTheme, type Mode } from "../lib/theme";
import { useWallet } from "../lib/wallet-connect";
import { Page, TopNav } from "../components/common";
import { WalletButton } from "../components/wallet-ui";
import { useWalletAddress } from "../lib/wallet";

const H2 = "font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;";
const CARD = "border: 1px solid #EBEBEB; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 14px;";
const ROW = "display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; font-size: 13px;";

export default function Settings() {
  const { mode, setMode } = useTheme();
  const w = useWallet();
  const [saved, setSaved] = useWalletAddress();
  const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
  return (
    <Page>
      <TopNav />
      <main style={st("max-width: 720px; margin: 0 auto; padding: 48px clamp(16px, 4vw, 48px) 96px; display: flex; flex-direction: column; gap: 24px;")}>
        <h1 style={st("font-size: 32px; line-height: 36px; letter-spacing: -0.025em; font-weight: 500; color: #111111;")}>Settings</h1>

        <section aria-labelledby="ap-h" style={st(CARD)}>
          <h2 id="ap-h" style={st(H2)}>Appearance</h2>
          <div role="radiogroup" aria-label="Theme" style={st("display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 3px; background: #F4F4F5; border-radius: 10px;")}>
            {([["system", "System"], ["light", "Light"], ["dark", "Dark"]] as [Mode, string][]).map(([m, label]) => {
              const on = mode === m;
              return <button key={m} type="button" role="radio" aria-checked={on} onClick={() => setMode(m)} style={st("height: 32px; border: 0; border-radius: 8px; cursor: pointer; font: 500 13px Inter, sans-serif; " + (on ? "background: #FFFFFF; color: #111111; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .06);" : "background: transparent; color: #6B6B6B;"))}>{label}</button>;
            })}
          </div>
          <p style={st("font-size: 12px; color: #6B6B6B;")}>System follows your device. Your choice is saved in this browser only.</p>
        </section>

        <section aria-labelledby="wl-h" style={st(CARD)}>
          <h2 id="wl-h" style={st(H2)}>Wallet</h2>
          {w.address ? (
            <>
              <div style={st(ROW + " border-bottom: 1px solid #EBEBEB;")}><span style={st("color: #6B6B6B;")}>Connected with</span><span style={st("color: #111111;")}>{w.walletName}</span></div>
              <div style={st(ROW)}><span style={st("color: #6B6B6B;")}>Address</span><span className="mono" title={w.address} style={st("font-size: 12px; color: #111111; overflow-wrap: anywhere; text-align: right;")}>{w.address}</span></div>
              <button className="press bs" type="button" onClick={() => void w.disconnect()} style={st("align-self: flex-start; height: 32px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;")}>Disconnect</button>
            </>
          ) : (
            <>
              <p style={st("font-size: 13px; color: #333333;")}>No wallet connected.</p>
              <div style={st("display: flex;")}><WalletButton align="left" /></div>
            </>
          )}
          <p style={st("font-size: 12px; line-height: 18px; color: #6B6B6B;")}>Noux never sees your keys. Your wallet approves every transaction and message.</p>
        </section>

        <section aria-labelledby="sv-h" style={st(CARD)}>
          <h2 id="sv-h" style={st(H2)}>Saved on this device</h2>
          <div style={st(ROW)}><span style={st("color: #6B6B6B;")}>Referral address</span><span className="mono" style={st("font-size: 12px; color: #111111;")}>{saved ? short(saved) : "none"}</span></div>
          <button className="press bs" type="button" disabled={!saved} onClick={() => setSaved("")} style={{ ...st("align-self: flex-start; height: 32px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;"), opacity: saved ? 1 : 0.5 }}>Forget it</button>
          <p style={st("font-size: 12px; line-height: 18px; color: #6B6B6B;")}>The address you typed into the referral box, kept in this browser so you don’t retype it. Nothing is stored on a server.</p>
        </section>

        <section aria-labelledby="nw-h" style={st(CARD)}>
          <h2 id="nw-h" style={st(H2)}>Network</h2>
          <div style={st("display: flex; flex-direction: column;")}>
            {[
              ["Cluster", "Solana devnet (no real money)"],
              ["Program", short(PROGRAM_ID.toBase58(), 6, 6)],
              ["Token", `Devnet USDC ${short(USDC_MINT.toBase58(), 4, 4)}`],
              ["Read API", hostOf(API_BASE)],
              ["Solana node", hostOf(RPC_URL)],
            ].map(([k, v], i, a) => <div key={k} style={st(ROW + (i < a.length - 1 ? " border-bottom: 1px solid #EBEBEB;" : ""))}><span style={st("color: #6B6B6B;")}>{k}</span><span className="mono" style={st("font-size: 12px; color: #111111;")}>{v}</span></div>)}
          </div>
        </section>
      </main>
    </Page>
  );
}
