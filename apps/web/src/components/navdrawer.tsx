import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { st } from "../lib/css";
import { Mark } from "./common";
import { WalletButton } from "./wallet-ui";
import { ThemeToggle } from "../lib/theme";
import { useApi, type Page, type Campaign } from "../lib/api";

const GROUPS: { title: string; items: { label: string; to: string; icon: string }[] }[] = [
  { title: "Explore", items: [
    { label: "Home", to: "/", icon: "M3 11l9-8 9 8M5 10v10h14V10" },
    { label: "Campaigns", to: "/campaigns", icon: "M4 6h16M4 12h16M4 18h10" },
    { label: "Receipts", to: "/receipts", icon: "M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6" },
    { label: "Docs", to: "/docs/quickstart", icon: "M6 3h9l4 4v14H6zM14 3v5h5" },
  ] },
  { title: "Distributor", items: [
    { label: "Earnings", to: "/app/earnings", icon: "M3 3v18h18M7 15l4-4 3 3 5-6" },
    { label: "Referral links", to: "/app/earnings#links", icon: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" },
  ] },
  { title: "Merchant", items: [
    { label: "Overview and campaigns", to: "/app/merchant", icon: "M3 12h4l3-8 4 16 3-8h4" },
  ] },
  { title: "Account", items: [
    { label: "Settings", to: "/settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12h2M18 12h2M12 4v2M12 18v2" },
  ] },
];

/** Hamburger + slide-in menu with every section of the product, so you never have to go back to the landing page to switch. */
export function NavMenu() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const first = useRef<HTMLAnchorElement>(null);
  const open_ = useApi<Page<Campaign>>(open ? "/campaigns?status=active&limit=1" : null);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", k);
    first.current?.focus();
    return () => window.removeEventListener("keydown", k);
  }, [open]);
  return (
    <>
      <button className="press gh" type="button" aria-label="Open menu" aria-expanded={open} aria-controls="nav-drawer" onClick={() => setOpen(true)}
        style={st("width: 36px; height: 36px; flex: none; border: 0; background: transparent; border-radius: 8px; color: #111111; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      {open && createPortal(
        <>
          <div className="scrim" onClick={() => setOpen(false)} style={st("position: fixed; inset: 0; z-index: 70; background: rgb(0 0 0 / .4);")} />
          <nav id="nav-drawer" aria-label="Sections" className="sheet-l" style={st("position: fixed; top: 8px; left: 8px; bottom: 8px; z-index: 71; width: min(300px, calc(100% - 16px)); background: #FFFFFF; border-radius: 16px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 24px 48px -12px rgb(0 0 0 / .18); display: flex; flex-direction: column; overflow-y: auto;")}>
            <div style={st("height: 56px; padding: 0 12px 0 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #EBEBEB;")}>
              <Mark /><span style={st("flex: 1; font-size: 17px; font-weight: 600; letter-spacing: -0.03em; color: #111111;")}>noux</span>
              <button className="press gh" type="button" aria-label="Close menu" onClick={() => setOpen(false)} style={st("width: 32px; height: 32px; border: 0; background: transparent; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center;")}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#333333" strokeWidth="1.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg></button>
            </div>
            <div style={st("padding: 12px; display: flex; flex-direction: column; gap: 16px;")}>
              <div style={st("display: flex; align-items: center; gap: 8px; padding: 0 4px;")}>
                <WalletButton align="left" />
                <span style={{ flex: 1 }} />
                <ThemeToggle />
              </div>
              {GROUPS.map((g, gi) => (
                <div key={g.title} style={st("display: flex; flex-direction: column; gap: 2px;")}>
                  <span style={st("font-size: 12px; font-weight: 500; color: #6B6B6B; padding: 0 8px 6px;")}>{g.title}</span>
                  {g.items.map((it, ii) => {
                    const cur = it.to.split("#")[0] === pathname && !it.to.includes("#");
                    return (
                      <Link key={it.label} ref={gi === 0 && ii === 0 ? first : undefined} className="nv" to={it.to} aria-current={cur ? "page" : undefined}
                        style={st("height: 36px; padding: 0 8px; border-radius: 8px; display: flex; align-items: center; gap: 10px; font-size: 14px; " + (cur ? "background: #F4F4F5; color: #111111; font-weight: 500;" : "color: #333333;"))}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={it.icon} /></svg>{it.label}
                        {it.label === "Campaigns" && open_.data && <span className="tn" style={st("margin-left: auto; font-size: 12px; color: #6B6B6B;")}>{open_.data.total} with budget left</span>}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <p style={st("padding: 12px 16px; border-top: 1px solid #EBEBEB; font-size: 12px; line-height: 18px; color: #6B6B6B;")}>Devnet: nothing here moves real money.</p>
          </nav>
        </>,
        document.body,
      )}
    </>
  );
}
