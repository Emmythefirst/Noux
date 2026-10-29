import { Link, NavLink } from "react-router-dom";
import type { CSSProperties, ReactNode } from "react";
import { st } from "../lib/css";
import { short } from "../lib/format";
import { explorerAddr, useCopy } from "../lib/api";
import { WalletButton } from "./wallet-ui";
import { NavMenu } from "./navdrawer";
import { ThemeToggle } from "../lib/theme";
import { useWallet } from "../lib/wallet-connect";

/** Fallback only: pages render the API's own `disclosure` string when they have it. */
export const DISCLOSURE_FALLBACK =
  "Distributors earn a commission when a buyer they referred pays for this service. Listings and rankings are not endorsements. Services marked “sample” were built by the Noux team for demonstration; their volume is not real market demand.";

export function Mark({ w = 24, h = 14 }: { w?: number; h?: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 24 14" aria-hidden="true">
      <rect x="0" y="2" width="13" height="10" rx="2.5" fill="#111111" />
      <rect x="15" y="2" width="5.5" height="10" rx="2.5" fill="#0F766E" />
      <rect x="22" y="2" width="2" height="10" rx="1" fill="#A1A1AA" />
    </svg>
  );
}

export const DevnetBadge = () => (
  <span className="mono" style={st("font-size: 11px; letter-spacing: 0.08em; color: #8A4B00; background: #FFF1D6; padding: 3px 8px; border-radius: 6px;")}>DEVNET</span>
);

/** Paused / Ended marker; nothing for an active campaign. */
export const StateBadge = ({ state, style }: { state?: "active" | "paused" | "ended"; style?: CSSProperties }) => state === "paused" || state === "ended" ? (
  <span style={{ ...st(state === "paused" ? "height: 20px; padding: 0 8px; border-radius: 6px; background: #FFF1D6; color: #8A4B00; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center;" : "height: 20px; padding: 0 8px; border-radius: 6px; background: #F4F4F5; color: #333333; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center;"), ...style }}>{state === "paused" ? "Paused" : "Ended"}</span>
) : null;

/** One quiet status marker for cards and the campaign header: paused/ended as a badge, budget spent as an amber badge, otherwise a green dot and the word Active. */
export const StatusChip = ({ state, spent }: { state?: "active" | "paused" | "ended"; spent: boolean }) => {
  if (state === "paused" || state === "ended") return <StateBadge state={state} />;
  if (spent) return <span style={st("flex: none; height: 20px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; background: #FFF1D6; color: #8A4B00;")}>Budget spent</span>;
  return <span style={st("flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #6B6B6B;")}><span aria-hidden="true" style={st("width: 6px; height: 6px; border-radius: 9999px; background: #15B042;")} />Active</span>;
};

export const SampleBadge = ({ style }: { style?: CSSProperties }) => (
  <span style={{ ...st("height: 20px; padding: 0 8px; border-radius: 6px; background: #F4F4F5; color: #333333; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center;"), ...style }}>Sample</span>
);

export const STATUS_COLORS = {
  settled: { bg: "#CAFACE", fg: "#0E7A2F", dot: "#15B042", label: "Settled" },
  open: { bg: "#E6F0FF", fg: "#0058B0", dot: "#0058B0", label: "Held" },
  refunded: { bg: "#FFF1D6", fg: "#8A4B00", dot: "#8A4B00", label: "Refunded" },
} as const;

export function SaleBadge({ status, text, dot = false, warn = false }: { status: keyof typeof STATUS_COLORS; text?: string; dot?: boolean; warn?: boolean }) {
  const c = warn ? STATUS_COLORS.refunded : STATUS_COLORS[status];
  return (
    <span style={{ ...st("height: 20px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; white-space: nowrap; gap: 6px;"), background: c.bg, color: c.fg }}>
      {dot && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 9999, background: c.dot }} />}
      {text ?? c.label}
    </span>
  );
}

/** An open sale with nothing paid into its vault yet is "awaiting payment", not "held". */
/** The vault holds money but less than the claim price: the program refuses to settle it (Underpaid); only the merchant can refund it. */
export function isUnderpaid(r: { status: string; funded: boolean; vaultAmount: string; price: string }): boolean {
  return r.status === "open" && r.funded && BigInt(r.vaultAmount) < BigInt(r.price);
}
export function openText(r: { funded: boolean; status?: string; vaultAmount?: string; price?: string }, leftSecs: number): string {
  if (!r.funded) return "Awaiting payment";
  if (r.vaultAmount !== undefined && r.price !== undefined && BigInt(r.vaultAmount) < BigInt(r.price)) return "Underpaid · can’t settle";
  return leftSecs > 0 ? `Held · ${mmssLocal(leftSecs)} left` : "Ready to settle";
}
const mmssLocal = (s: number) => `${Math.floor(Math.ceil(s) / 60)}:${String(Math.ceil(s) % 60).padStart(2, "0")}`;

export const Dot = ({ color = "#15B042" }: { color?: string }) => (
  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 9999, background: color, display: "inline-block", flex: "none" }} />
);

export function Disclosure({ text, style }: { text?: string; style?: CSSProperties }) {
  return <p style={{ ...st("font-size: 12px; line-height: 18px; color: #6B6B6B; max-width: 820px;"), ...style }}>{text ?? DISCLOSURE_FALLBACK}</p>;
}

export function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
  );
}

/** Middle-truncated mono address; optional copy button and explorer link. */
export function Addr({ value, copy = false, explorer = false, style, head = 4, tail = 4 }: { value: string; copy?: boolean; explorer?: boolean; style?: CSSProperties; head?: number; tail?: number }) {
  const [copied, doCopy] = useCopy();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="mono" title={value} style={{ fontSize: 12, ...style }}>{short(value, head, tail)}</span>
      {copy && (
        <button type="button" className="press ib" aria-label={copied ? "Copied" : "Copy address"} onClick={() => doCopy("a", value)}
          style={st("width: 22px; height: 22px; border: 0; background: transparent; border-radius: 6px; color: #6B6B6B; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;")}>
          {copied ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg> : <CopyIcon />}
        </button>
      )}
      {explorer && <a href={explorerAddr(value)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Explorer ↗</a>}
    </span>
  );
}

/** Top navigation. `landing` has the marketing links; `app` pages show the shorter set. */
export function TopNav({ variant = "app", surface = "#FFFFFF", cta = false }: { variant?: "landing" | "app"; surface?: "#FFFFFF" | "#FAFAFA"; cta?: boolean }) {
  const w = useWallet();
  const link = ({ isActive }: { isActive: boolean }): CSSProperties => (isActive ? st("color: #111111; font-weight: 500;") : st("color: #6B6B6B;"));
  return (
    <header style={st(`position: sticky; top: 0; z-index: 20; background: var(${surface === "#FFFFFF" ? "--glass" : "--glass-2"}); backdrop-filter: saturate(180%) blur(12px); -webkit-backdrop-filter: saturate(180%) blur(12px); border-bottom: 1px solid #EBEBEB;`)}>
      <nav className="topnav" aria-label="Primary" style={st("max-width: 1280px; margin: 0 auto; padding: 0 clamp(16px, 4vw, 48px); height: 60px; display: flex; align-items: center; gap: 32px;")}>
        {variant === "app" && <NavMenu />}
        <Link to="/" aria-label="Noux home" style={st("display: flex; align-items: center; gap: 10px; color: #111111; margin-left: " + (variant === "app" ? "-16px" : "0") + ";")}>
          <Mark />
          <span style={st("font-size: 17px; font-weight: 600; letter-spacing: -0.03em;")}>noux</span>
        </Link>
        <div className="hide-sm" style={st("display: flex; gap: 24px; font-size: 14px;")}>
          <NavLink className="nl" to="/campaigns" style={link}>Campaigns</NavLink>
          <NavLink className="nl" to="/receipts" style={link}>Receipts</NavLink>
          <NavLink className="nl" to="/docs/overview" style={link}>Docs</NavLink>
          {variant === "landing" && <a className="nl" href="/#security" style={st("color: #6B6B6B;")}>Security</a>}
        </div>
        <div style={{ flex: 1 }} />
        {variant === "landing" ? (
          <>
            <DevnetBadge />
            <Link className="press bi navcta" to="/app/merchant" style={st("height: 36px; padding: 0 16px; border-radius: 9999px; background: #111111; color: #FFFFFF; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; white-space: nowrap;")}>Create campaign</Link>
          </>
        ) : (
          <>
            {cta && <Link className="press bi hide-xs" to="/app/merchant" style={st("height: 36px; padding: 0 16px; border-radius: 9999px; background: #111111; color: #FFFFFF; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; white-space: nowrap;")}>{w.address ? "My campaigns" : "Create campaign"}</Link>}
            <DevnetBadge />
            <WalletButton compact />
          </>
        )}
        <ThemeToggle />
      </nav>
    </header>
  );
}

export function SiteFooter({ disclosure }: { disclosure?: string }) {
  return (
    <footer style={st("border-top: 1px solid #EBEBEB; background: #FAFAFA;")}>
      <div style={st("max-width: 1280px; margin: 0 auto; padding: 40px clamp(16px, 4vw, 48px) 48px; display: flex; flex-direction: column; gap: 24px;")}>
        <div style={st("display: flex; flex-wrap: wrap; gap: 16px 32px; align-items: center; font-size: 14px;")}>
          <span style={st("display: flex; align-items: center; gap: 8px; color: #111111; font-weight: 600; letter-spacing: -0.03em;")}><Mark w={20} h={12} />noux</span>
          <Link className="nl" to="/campaigns" style={st("color: #6B6B6B;")}>Campaigns</Link>
          <Link className="nl" to="/docs/overview" style={st("color: #6B6B6B;")}>Docs</Link>
          <Link className="nl" to="/docs/status" style={st("color: #6B6B6B;")}>Status</Link>
          <a className="nl" href="https://github.com/Emmythefirst/Noux" target="_blank" rel="noreferrer" style={st("color: #6B6B6B;")}>GitHub ↗</a>
        </div>
        <Disclosure text={disclosure} />
      </div>
    </footer>
  );
}

/** Spinner + skeleton shown while a free-tier server wakes up. */
export function WakingBanner({ what = "index" }: { what?: string }) {
  return (
    <div className="fadein" role="status" style={st("display: flex; align-items: center; gap: 14px; padding: 16px 20px; border: 1px solid #EBEBEB; border-radius: 12px; background: #FAFAFA;")}>
      <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56" /></svg>
      <div style={st("display: flex; flex-direction: column; gap: 2px;")}>
        <span style={st("font-size: 14px; color: #111111; font-weight: 500;")}>Waking the {what}…</span>
        <span style={st("font-size: 13px; color: #6B6B6B;")}>Our free server sleeps when idle. This takes up to a minute the first time.</span>
      </div>
    </div>
  );
}

export function ErrorState({ title = "Couldn’t load this", body = "The index didn’t answer. Check your connection, then try again.", onRetry }: { title?: string; body?: string; onRetry?: () => void }) {
  return (
    <div role="alert" style={st("display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; padding: 64px 24px; border: 1px solid #EBEBEB; border-radius: 12px;")}>
      <div style={st("width: 44px; height: 44px; border-radius: 12px; background: #FFE8E6; display: flex; align-items: center; justify-content: center;")}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#B42318" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
      </div>
      <h2 style={st("font-size: 16px; font-weight: 500; color: #111111;")}>{title}</h2>
      <p style={st("font-size: 14px; color: #6B6B6B; max-width: 380px;")}>{body}</p>
      {onRetry && <button className="press bs" type="button" onClick={onRetry} style={st("height: 32px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;")}>Try again</button>}
    </div>
  );
}

export function SkeletonCards({ n = 3, h = 300 }: { n?: number; h?: number }) {
  return (
    <div style={st("display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: 16px;")}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="pulse" aria-hidden="true" style={{ ...st("border: 1px solid #EBEBEB; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 12px;"), height: h }}>
          <div style={st("width: 55%; height: 16px; border-radius: 6px; background: #F4F4F5;")} />
          <div style={st("width: 35%; height: 12px; border-radius: 6px; background: #F4F4F5;")} />
          <div style={st("margin-top: 16px; width: 100%; height: 48px; border-radius: 8px; background: #F4F4F5;")} />
          <div style={st("width: 100%; height: 6px; border-radius: 9999px; background: #F4F4F5;")} />
        </div>
      ))}
    </div>
  );
}

/** "Indexed 12 s ago" with a live tick from the index's own age. */
export function Freshness({ ageSeconds, fetchedAt, now, error }: { ageSeconds: number | null | undefined; fetchedAt: number; now: number; error?: string | null }) {
  if (ageSeconds === null || ageSeconds === undefined) return <span className="tn" style={st("font-size: 12px; color: #6B6B6B; display: flex; align-items: center; gap: 6px;")}><Dot color="#8A8A8A" />Index status unknown</span>;
  const age = ageSeconds + Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const stale = age > 180 || !!error;
  return (
    <span className="tn" style={st("font-size: 12px; color: #6B6B6B; display: flex; align-items: center; gap: 6px;")}>
      <Dot color={stale ? "#8A4B00" : "#15B042"} />
      {stale ? `Index is behind: last synced ${age} s ago` : `Indexed ${age} s ago`}
    </span>
  );
}

export function Page({ children, bg = "#FFFFFF" }: { children: ReactNode; bg?: string }) {
  return <div style={{ minHeight: "100vh", background: bg }}>{children}</div>;
}
