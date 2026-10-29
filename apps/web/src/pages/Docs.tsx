import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { st } from "../lib/css";
import { useApi, useIndexFreshness, type IndexInfo } from "../lib/api";
import { DevnetBadge, Dot, Mark, Page } from "../components/common";
import { NavMenu } from "../components/navdrawer";
import { ThemeToggle } from "../lib/theme";
import { WalletButton } from "../components/wallet-ui";
import { GROUPS, PAGES, githubUrl, pageBySlug } from "../docs/registry";
import { renderDoc, type TocItem } from "../docs/render";
import QuickstartPage, { QUICKSTART_TOC } from "../docs/QuickstartPage";
import StatusPage from "../docs/StatusPage";
import { DocsSearch } from "../docs/search";

function useActiveHeading(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  const key = ids.join("|");
  useEffect(() => {
    setActive(ids[0]);
    const els = ids.map((i) => document.getElementById(i)).filter(Boolean) as HTMLElement[];
    if (els.length === 0) return;
    const io = new IntersectionObserver((es) => {
      const vis = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) setActive(vis.target.id);
    }, { rootMargin: "-80px 0px -65% 0px" });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
}

export default function Docs() {
  const { slug } = useParams();
  const { hash } = useLocation();
  const nav = useNavigate();
  const [searching, setSearching] = useState(false);
  const page = slug ? pageBySlug(slug) : undefined;
  const idx = useApi<IndexInfo>("/index");
  const fresh = useIndexFreshness();
  const readUp = !!idx.data;
  const age = fresh.info?.ageSeconds != null ? fresh.info.ageSeconds + Math.max(0, Math.floor((fresh.now - fresh.fetchedAt) / 1000)) : null;

  const rendered = useMemo(() => (page?.kind === "md" ? renderDoc(page.md) : null), [page]);
  const toc: TocItem[] = rendered ? rendered.toc : page?.kind === "quickstart" ? QUICKSTART_TOC.map(([id, label, sub]) => ({ id, label, level: (sub ? 3 : 2) as 2 | 3 })) : [];
  const active = useActiveHeading(toc.map((t) => t.id));

  // ⌘K / Ctrl+K opens search; "/" too when not typing
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = /^(input|textarea|select)$/i.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); setSearching(true); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);

  // new page -> top; an #anchor -> that heading (after the page has rendered)
  useEffect(() => {
    if (hash) requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }));
    else window.scrollTo({ top: 0 });
  }, [slug, hash, page]);

  if (!slug) return <Navigate to="/docs/overview" replace />;
  if (!page) return (
    <Page><DocsHeader onSearch={() => setSearching(true)} />
      <main style={st("max-width: 720px; margin: 0 auto; padding: 96px 24px; display: flex; flex-direction: column; gap: 12px;")}>
        <h1 style={st("font-size: 32px; line-height: 36px; letter-spacing: -0.025em; font-weight: 500; color: #111111;")}>Page not found</h1>
        <p style={st("font-size: 14px; color: #6B6B6B;")}>There is no docs page called “{slug}”.</p>
        <Link to="/docs/overview" style={st("font-size: 14px; font-weight: 500;")}>Go to the overview →</Link>
      </main>
    </Page>
  );

  const i = PAGES.indexOf(page);
  const prev = PAGES[i - 1], next = PAGES[i + 1];

  // internal links inside rendered markdown navigate without a full reload
  const onDocClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a[data-doc-link]") as HTMLAnchorElement | null;
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); nav(a.getAttribute("href")!); }
  };

  return (
    <Page>
      <DocsHeader onSearch={() => setSearching(true)} />
      <DocsSearch open={searching} onClose={() => setSearching(false)} />
      <div style={st("display: flex; flex-wrap: wrap; max-width: 1440px; margin: 0 auto;")}>
        <nav aria-label="Docs" style={st("flex: 1 1 240px; max-width: 280px; padding: 28px 16px 48px 24px; display: flex; flex-direction: column; gap: 24px; border-right: 1px solid #EBEBEB; background: #FAFAFA;")}>
          {GROUPS.map((g) => (
            <div key={g.title} style={st("display: flex; flex-direction: column; gap: 2px;")}>
              <span style={st("font-size: 12px; font-weight: 500; color: #6B6B6B; padding: 0 8px 6px;")}>{g.title}</span>
              {g.pages.map((p) => {
                const cur = p.slug === page.slug;
                return <Link key={p.slug} className="nv" to={`/docs/${p.slug}`} aria-current={cur ? "page" : undefined} style={st("height: 32px; padding: 0 8px; border-radius: 8px; font-size: 14px; display: flex; align-items: center; gap: 8px; " + (cur ? "background: #F4F4F5; color: #111111; font-weight: 500;" : "color: #333333;"))}>{p.title}</Link>;
              })}
            </div>
          ))}
        </nav>

        <main style={st("flex: 999 1 560px; min-width: 0; padding: 40px clamp(16px, 4vw, 64px) 96px;")}>
          <article style={st("max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px;")}>
            <div style={st("display: flex; flex-direction: column; gap: 12px;")}>
              <span style={st("font-size: 13px; color: #6B6B6B;")}>{page.group}</span>
              <h1 style={st("font-size: 44px; line-height: 46px; letter-spacing: -0.03em; font-weight: 500; color: #111111;")}>{page.title}</h1>
            </div>
            {page.kind === "md" && rendered && <div className="doc" onClick={onDocClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />}
            {page.kind === "quickstart" && <QuickstartPage />}
            {page.kind === "status" && <StatusPage />}

            <div style={st("display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; margin-top: 24px;")}>
              {prev ? <Link className="bs press" to={`/docs/${prev.slug}`} style={st("display: flex; flex-direction: column; gap: 4px; padding: 16px; border: 1px solid #EBEBEB; border-radius: 12px; color: #333333;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Previous</span><span style={st("font-size: 15px; font-weight: 500; color: #111111;")}>← {prev.title}</span></Link> : <span />}
              {next ? <Link className="bs press" to={`/docs/${next.slug}`} style={st("display: flex; flex-direction: column; gap: 4px; padding: 16px; border: 1px solid #EBEBEB; border-radius: 12px; color: #333333; text-align: right;")}><span style={st("font-size: 12px; color: #6B6B6B;")}>Next</span><span style={st("font-size: 15px; font-weight: 500; color: #111111;")}>{next.title} →</span></Link> : <span />}
            </div>
            <p className="tn" style={st("font-size: 12px; color: #6B6B6B; border-top: 1px solid #EBEBEB; padding-top: 16px;")}>Devnet documentation · <a href={githubUrl(page)} target="_blank" rel="noreferrer">Edit on GitHub ↗</a></p>
          </article>
        </main>

        <aside className="toc-col" style={st("flex: 0 0 240px; padding: 40px 24px; display: flex; flex-direction: column; gap: 28px;")}>
          {toc.length > 0 && (
            <nav aria-label="On this page" style={st("display: flex; flex-direction: column; gap: 8px; font-size: 13px; position: sticky; top: 80px;")}>
              <span style={st("font-size: 12px; font-weight: 500; color: #111111;")}>On this page</span>
              {toc.map((t) => (
                <a key={t.id} className="toc" href={`#${t.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(t.id)?.scrollIntoView({ behavior: "smooth" }); }}
                  style={st("color: " + (active === t.id ? "#0F766E; font-weight: 500;" : "#6B6B6B;") + (t.level === 3 ? " padding-left: 12px;" : ""))}>{t.label}</a>
              ))}
            </nav>
          )}
          <section id="status" aria-label="Service status" style={st("display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid #EBEBEB; border-radius: 12px; font-size: 12px;")}>
            <Link to="/docs/status" style={st("font-weight: 500; color: #111111; font-size: 12px;")}>Status · devnet</Link>
            <div style={st("display: flex; justify-content: space-between; color: #333333;")}><span style={st("display: flex; gap: 6px; align-items: center;")}><Dot color={readUp ? "#15B042" : idx.loading ? "#8A8A8A" : "#D92D20"} />Read API</span><span style={st("color: #6B6B6B;")}>{readUp ? "Up" : idx.loading ? "Checking…" : "Down"}</span></div>
            <div className="tn" style={st("display: flex; justify-content: space-between; color: #333333;")}><span style={st("display: flex; gap: 6px; align-items: center;")}><Dot color={!readUp ? "#8A8A8A" : age !== null && age > 180 ? "#8A4B00" : "#15B042"} />Indexer</span><span style={st("color: #6B6B6B;")}>{age === null ? "—" : `${age} s behind`}</span></div>
            <span style={st("color: #6B6B6B; line-height: 16px;")}>May take up to a minute to wake after 15 min idle.</span>
          </section>
        </aside>
      </div>
    </Page>
  );
}

function DocsHeader({ onSearch }: { onSearch: () => void }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <header style={st("position: sticky; top: 0; z-index: 20; background: var(--glass-docs); backdrop-filter: saturate(180%) blur(12px); -webkit-backdrop-filter: saturate(180%) blur(12px); border-bottom: 1px solid #EBEBEB;")}>
      <nav className="topnav" aria-label="Primary" style={st("padding: 0 clamp(12px, 4vw, 24px); height: 56px; display: flex; align-items: center; gap: 24px;")}>
        <NavMenu />
        <Link to="/" aria-label="Noux home" style={st("display: flex; align-items: center; gap: 10px; color: #111111; margin-left: -16px;")}>
          <Mark /><span style={st("font-size: 17px; font-weight: 600; letter-spacing: -0.03em;")}>noux</span><span className="hide-xs" style={st("font-size: 14px; color: #6B6B6B; font-weight: 400;")}>Docs</span>
        </Link>
        <button className="press bs" type="button" onClick={onSearch} aria-label="Search docs" style={st("flex: 0 1 320px; height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 12px; border: 1px solid #EBEBEB; border-radius: 10px; background: #FAFAFA; color: #6B6B6B; font: 400 14px Inter, sans-serif; cursor: pointer; text-align: left;")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B6B6B" strokeWidth="1.5" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <span className="hide-xs" style={{ flex: 1 }}>Search docs</span>
          <kbd className="mono hide-sm" style={st("font-size: 11px; color: #333333; background: #FFFFFF; border: 1px solid #EBEBEB; border-radius: 4px; padding: 1px 5px;")}>{mac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <div style={{ flex: 1 }} />
        <div className="hide-sm" style={st("display: flex; gap: 20px; font-size: 14px;")}>
          <Link className="nl" to="/campaigns" style={st("color: #6B6B6B;")}>Campaigns</Link>
          <a className="nl" href="https://github.com/Emmythefirst/Noux" target="_blank" rel="noreferrer" style={st("color: #6B6B6B;")}>GitHub ↗</a>
        </div>
        <DevnetBadge />
        <WalletButton compact />
        <ThemeToggle />
      </nav>
    </header>
  );
}
