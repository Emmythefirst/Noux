import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { st } from "../lib/css";
import type { Listing } from "../lib/api";
import { CATEGORIES, short } from "../lib/format";
import { publishListing, removeListing, validateListing } from "../lib/publish-listing";
import { useWallet } from "../lib/wallet-connect";

const FIELD = "height: 40px; padding: 0 12px; border: 1px solid #8A8A8A; border-radius: 8px; font: 400 14px Inter, sans-serif; color: #111111; background: #FFFFFF; width: 100%;";
const LBL = "display: flex; flex-direction: column; gap: 6px;";
const CAP = "font-size: 12px; color: #6B6B6B;";

/** Publish (or update) the merchant-signed listing of an existing campaign. */
export function ListingModal({ campaign, existing, onClose, onDone }: { campaign: string; existing: Listing | null; onClose: () => void; onDone: () => void }) {
  const w = useWallet();
  const [name, setName] = useState(existing?.name ?? ""), [desc, setDesc] = useState(existing?.description ?? ""), [cat, setCat] = useState(existing?.category ?? "data-feeds");
  const [url, setUrl] = useState(existing?.endpointUrl ?? ""), [route, setRoute] = useState(existing?.route ?? "GET /"), [price, setPrice] = useState(existing?.displayPrice ?? "$0.10");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose, busy]);

  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = async () => {
    setBusy(true); setErr(null);
    try { await removeListing(campaign, w.signMessage); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); setConfirmRemove(false); }
  };

  const submit = async () => {
    const listing = { name: name.trim(), description: desc.trim(), category: cat, endpointUrl: url.trim(), route: route.trim(), displayPrice: price.trim(), isSample: existing?.isSample ?? false };
    const p = validateListing(listing); if (p) { setErr(p); return; }
    setBusy(true); setErr(null);
    try { await publishListing(campaign, listing, w.signMessage); onDone(); }
    catch (e) { setErr((e as Error).message === "listing must be signed by the campaign's merchant wallet and be fresh (60s)" ? "That wallet isn’t this campaign’s merchant, or the approval took longer than a minute. Try again." : (e as Error).message); setBusy(false); }
  };

  return createPortal(
    <>
      <div className="scrim" onClick={() => !busy && onClose()} style={st("position: fixed; inset: 0; z-index: 60; background: rgb(0 0 0 / .4);")} />
      {/* centred by a plain flex wrapper: the .dialog animation sets transform, so the dialog itself must not rely on one */}
      <div style={st("position: fixed; inset: 0; z-index: 61; display: flex; align-items: center; justify-content: center; padding: 8px; pointer-events: none;")}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="lm-h" style={st("pointer-events: auto; width: min(520px, 100%); max-height: 100%; overflow-y: auto; background: #FFFFFF; border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 24px 48px -12px rgb(0 0 0 / .18);")}>
        <div style={st("display: flex; flex-direction: column; gap: 4px;")}>
          <h2 id="lm-h" style={st("font-size: 16px; line-height: 20px; letter-spacing: -0.01em; font-weight: 500; color: #111111;")}>{existing ? "Edit listing" : "List this campaign"}</h2>
          <p style={st("font-size: 13px; line-height: 18px; color: #6B6B6B;")}>Campaign <span className="mono">{short(campaign)}</span>. This is what people see in the directory. You sign it with your wallet; only the wallet that created the campaign can publish it.</p>
        </div>
        <fieldset disabled={busy} style={st("border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 12px;")}>
          <label style={st(LBL)}><span style={st(CAP)}>Name</span><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Market brief" style={st(FIELD)} /></label>
          <label style={st(LBL)}><span style={st(CAP)}>Description</span><textarea value={desc} maxLength={280} rows={2} onChange={(e) => setDesc(e.target.value)} placeholder="What a buyer gets for one call" style={{ ...st(FIELD), height: 64, padding: 12, resize: "vertical" }} /></label>
          <label style={st(LBL)}><span style={st(CAP)}>Endpoint URL (https)</span><input className="mono" value={url} maxLength={200} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/report" style={{ ...st(FIELD), fontSize: 12 }} /></label>
          <div style={st("display: grid; grid-template-columns: 1fr 1fr; gap: 12px;")}>
            <label style={st(LBL)}><span style={st(CAP)}>Route</span><input className="mono" value={route} maxLength={80} onChange={(e) => setRoute(e.target.value)} style={{ ...st(FIELD), fontSize: 12 }} /></label>
            <label style={st(LBL)}><span style={st(CAP)}>Price shown</span><input value={price} maxLength={20} onChange={(e) => setPrice(e.target.value)} style={st(FIELD)} /></label>
          </div>
          <label style={st(LBL)}><span style={st(CAP)}>Category</span><select value={cat} onChange={(e) => setCat(e.target.value)} style={st(FIELD)}>{Object.entries(CATEGORIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </fieldset>
        {err && <p role="alert" style={st("font-size: 13px; line-height: 18px; color: #B42318;")}>{err}</p>}
        {busy && <p role="status" style={st("font-size: 13px; color: #333333;")}>Approve the message in your wallet, then publishing…</p>}
        {existing && (confirmRemove ? (
          <div role="alert" style={st("border: 1px solid #F5D9A8; background: rgba(138,75,0,0.05); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; line-height: 18px; color: #333333;")}>
            <span>Remove this campaign from the directory? It stays on-chain and keeps working for anyone with the link. You can list it again later.</span>
            <div style={st("display: flex; gap: 8px;")}>
              <button className="press bd" type="button" disabled={busy} onClick={() => void remove()} style={{ ...st("height: 32px; padding: 0 12px; border: 0; background: #D92D20; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #FFFFFF; cursor: pointer;"), opacity: busy ? 0.6 : 1 }}>Sign and remove</button>
              <button className="press bs" type="button" disabled={busy} onClick={() => setConfirmRemove(false)} style={st("height: 32px; padding: 0 12px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;")}>Keep it listed</button>
            </div>
          </div>
        ) : <button type="button" disabled={busy} onClick={() => setConfirmRemove(true)} style={st("align-self: flex-start; border: 0; background: none; padding: 0; color: #B42318; font: 500 13px Inter, sans-serif; cursor: pointer;")}>Remove from directory</button>)}
        <div style={st("display: flex; gap: 8px; justify-content: flex-end;")}>
          <button className="press bs" type="button" disabled={busy} onClick={onClose} style={st("height: 36px; padding: 0 14px; border: 1px solid #D4D4D8; background: #FFFFFF; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #111111; cursor: pointer;")}>Cancel</button>
          <button className="press bp" type="button" disabled={busy} onClick={() => void submit()} style={{ ...st("height: 36px; padding: 0 16px; border: 0; background: #0F766E; border-radius: 10px; font: 500 13px Inter, sans-serif; color: #FFFFFF; cursor: pointer;"), opacity: busy ? 0.6 : 1 }}>{existing ? "Sign and update" : "Sign and publish"}</button>
        </div>
      </div>
      </div>
    </>,
    document.body,
  );
}
