import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { st } from "../lib/css";
import { PAGES } from "./registry";
import { plainText, renderDoc } from "./render";
import { QUICKSTART_TOC } from "./QuickstartPage";

interface Entry { slug: string; title: string; group: string; heading: string | null; id: string | null; text: string }
let INDEX: Entry[] | null = null;
function buildIndex(): Entry[] {
  if (INDEX) return INDEX;
  const out: Entry[] = [];
  for (const p of PAGES) {
    if (p.kind === "md") {
      const { toc } = renderDoc(p.md);
      out.push({ slug: p.slug, title: p.title, group: p.group, heading: null, id: null, text: plainText(p.md) });
      for (const h of toc) out.push({ slug: p.slug, title: p.title, group: p.group, heading: h.label, id: h.id, text: h.label });
    } else if (p.kind === "quickstart") {
      out.push({ slug: p.slug, title: p.title, group: p.group, heading: null, id: null, text: "install the gateway create a campaign put the gateway in front of your route options run the keeper make a test purchase npx noux pnpm add" });
      for (const [id, label] of QUICKSTART_TOC) out.push({ slug: p.slug, title: p.title, group: p.group, heading: label, id, text: label });
    } else out.push({ slug: p.slug, title: p.title, group: p.group, heading: null, id: null, text: "service status read api indexer claims uptime protocol fee config" });
  }
  return (INDEX = out);
}

export interface Hit { entry: Entry; snippet: string; score: number }
/** Every word must appear. Title > heading > body. Returns the best entries (one per page+heading). */
export function searchDocs(query: string, limit = 8): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: Hit[] = [];
  for (const e of buildIndex()) {
    const hay = (e.heading ?? "").toLowerCase(), title = e.title.toLowerCase(), body = e.text.toLowerCase();
    if (!words.every((w) => hay.includes(w) || title.includes(w) || body.includes(w))) continue;
    let score = 0;
    for (const w of words) score += (title.includes(w) ? (e.heading ? 2 : 8) : 0) + (hay.includes(w) ? 6 : 0) + Math.min(3, body.split(w).length - 1);
    if (e.heading) score += 1; // a heading hit is more specific than a page hit
    const i = body.indexOf(words[0]);
    const snippet = e.heading ? e.heading : (i >= 0 ? (i > 40 ? "…" : "") + e.text.slice(Math.max(0, i - 40), i + 90) + "…" : e.title);
    hits.push({ entry: e, snippet, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function DocsSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => (open ? searchDocs(q) : []), [q, open]);
  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => setSel(0), [q]);
  if (!open) return null;
  const go = (h: Hit) => { onClose(); nav(`/docs/${h.entry.slug}${h.entry.id ? "#" + h.entry.id : ""}`); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter" && hits[sel]) go(hits[sel]);
  };
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} style={st("position: fixed; inset: 0; z-index: 80; background: rgb(0 0 0 / .4);")} />
      <div style={st("position: fixed; inset: 0; z-index: 81; display: flex; align-items: flex-start; justify-content: center; padding: 12vh 8px 8px; pointer-events: none;")}>
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Search docs" onKeyDown={key} style={st("pointer-events: auto; width: min(560px, 100%); background: #FFFFFF; border-radius: 16px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 24px 48px -12px rgb(0 0 0 / .18); overflow: hidden; display: flex; flex-direction: column;")}>
          <div style={st("display: flex; align-items: center; gap: 10px; padding: 0 16px; height: 52px; border-bottom: 1px solid #EBEBEB;")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.5" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the docs" aria-label="Search the docs" style={st("flex: 1; border: 0; outline: 0; background: transparent; font: 400 15px Inter, sans-serif; color: #111111;")} />
            <kbd className="mono" style={st("font-size: 11px; color: #333333; border: 1px solid #EBEBEB; border-radius: 4px; padding: 1px 5px;")}>Esc</kbd>
          </div>
          <ul role="listbox" style={st("list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow-y: auto;")}>
            {q.trim() === "" && <li style={st("padding: 16px 12px; font-size: 13px; color: #6B6B6B;")}>Type to search every page. Try “refund”, “claim”, “fee” or “keeper”.</li>}
            {q.trim() !== "" && hits.length === 0 && <li style={st("padding: 16px 12px; font-size: 13px; color: #6B6B6B;")}>No results for “{q}”.</li>}
            {hits.map((h, i) => (
              <li key={h.entry.slug + (h.entry.id ?? "")} role="option" aria-selected={i === sel}>
                <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(h)} style={st("width: 100%; text-align: left; border: 0; cursor: pointer; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; font-family: Inter, sans-serif; " + (i === sel ? "background: #F4F4F5;" : "background: transparent;"))}>
                  <span style={st("font-size: 12px; color: #6B6B6B;")}>{h.entry.group} · {h.entry.title}</span>
                  <span style={st("font-size: 14px; color: #111111; font-weight: 500;")}>{h.entry.heading ?? h.entry.title}</span>
                  {!h.entry.heading && <span style={st("font-size: 12px; color: #6B6B6B;")}>{h.snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>,
    document.body,
  );
}
