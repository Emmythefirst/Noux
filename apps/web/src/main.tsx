import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useLocation } from "react-router-dom";
import "./styles.css";
import Landing from "./pages/Landing";
import Directory from "./pages/Directory";
import CampaignPage from "./pages/Campaign";
import ReceiptPage, { LatestReceipt } from "./pages/ReceiptPage";
import Docs from "./pages/Docs";
import Merchant from "./pages/Merchant";
import Distributor from "./pages/Distributor";
import { Page, TopNav } from "./components/common";
import { st } from "./lib/css";

const TITLES: [RegExp, string][] = [
  [/^\/campaigns\/.+/, "Campaign · Noux"], [/^\/campaigns/, "Campaigns · Noux"], [/^\/r\//, "Receipt · Noux"], [/^\/receipts/, "Receipts · Noux"],
  [/^\/docs/, "Quickstart · Noux docs"], [/^\/app\/merchant/, "Merchant overview · Noux"], [/^\/app\/earnings/, "Distributor earnings · Noux"],
];

function Chrome({ children }: { children: React.ReactNode }) {
  const { pathname, hash } = useLocation();
  useEffect(() => { document.title = TITLES.find(([re]) => re.test(pathname))?.[1] ?? "Noux · Pay for buyers, not clicks"; }, [pathname]);
  useEffect(() => { // new route -> top of page, unless the URL targets an anchor
    if (hash) { requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView()); } else window.scrollTo({ top: 0 });
  }, [pathname, hash]);
  return <>{children}</>;
}

function NotFound() {
  return (
    <Page><TopNav />
      <main style={st("max-width: 640px; margin: 0 auto; padding: 96px clamp(16px, 4vw, 48px); display: flex; flex-direction: column; gap: 12px;")}>
        <h1 style={st("font-size: 32px; line-height: 36px; letter-spacing: -0.025em; font-weight: 500; color: #111111;")}>Page not found</h1>
        <p style={st("font-size: 14px; color: #6B6B6B;")}>That address doesn’t exist on Noux.</p>
        <Link to="/" style={st("font-size: 14px; font-weight: 500;")}>Go home →</Link>
      </main>
    </Page>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Chrome>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/campaigns" element={<Directory />} />
          <Route path="/campaigns/:address" element={<CampaignPage />} />
          <Route path="/receipts" element={<LatestReceipt />} />
          <Route path="/r/:sale" element={<ReceiptPage />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/docs/quickstart" element={<Docs />} />
          <Route path="/app/merchant" element={<Merchant />} />
          <Route path="/app/earnings" element={<Distributor />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Chrome>
    </BrowserRouter>
  </StrictMode>,
);
