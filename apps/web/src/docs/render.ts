import { Marked } from "marked";
import { mapDocLink } from "./registry";

export interface TocItem { id: string; label: string; level: 2 | 3 }
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Markdown -> HTML (our own trusted docs, rendered at runtime) plus a table of contents from the h2/h3 headings. */
export function renderDoc(md: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const seen = new Map<string, number>();
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    renderer: {
      heading(text, level) {
        let id = slug(text); const n = seen.get(id) ?? 0; seen.set(id, n + 1); if (n) id += `-${n + 1}`;
        if (level === 2 || level === 3) toc.push({ id, label: strip(text), level });
        return `<h${level} id="${id}">${text}</h${level}>`;
      },
      codespan(text) { return `<code class="i">${text}</code>`; },
      code(code, lang) { return `<figure class="doc-code"><pre><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(code)}</code></pre></figure>`; },
      table(header, body) { return `<div class="doc-table"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`; },
      blockquote(quote) {
        const warn = /^\s*<p><strong>Warning/.test(quote), note = /^\s*<p><strong>Note/.test(quote);
        return `<div class="callout ${warn ? "callout-warn" : "callout-note"}" role="note">${note || warn ? quote : quote}</div>`;
      },
      link(href, _title, text) {
        const t = mapDocLink(href);
        return "to" in t ? `<a href="${esc(t.to)}" data-doc-link>${text}</a>` : `<a href="${esc(t.external)}" target="_blank" rel="noreferrer">${text}</a>`;
      },
    },
  });
  const html = m.parse(md) as string;
  return { html, toc };
}

/** Plain text of a markdown page, for search. */
export const plainText = (md: string) => md.replace(/```[\s\S]*?```/g, (b) => b.replace(/```\w*\n?/g, "")).replace(/[`*_>#|]/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
