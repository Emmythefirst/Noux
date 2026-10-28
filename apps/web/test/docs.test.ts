import { describe, it, expect } from "vitest";
import { PAGES, GROUPS, mapDocLink, pageBySlug, section } from "../src/docs/registry";
import { renderDoc, plainText } from "../src/docs/render";
import { searchDocs } from "../src/docs/search";

describe("docs registry", () => {
  it("has the 15 pages of the design, each with a unique slug, in 5 groups", () => {
    expect(PAGES).toHaveLength(15);
    expect(new Set(PAGES.map((p) => p.slug)).size).toBe(15);
    expect(GROUPS.map((g) => g.title)).toEqual(["Getting started", "Merchants", "Distributors", "Reference", "Trust"]);
  });
  it("every markdown page has real content (nothing is a stub)", () => {
    for (const p of PAGES.filter((x) => x.kind === "md")) expect(plainText(p.md).length, p.slug).toBeGreaterThan(400);
  });
  it("section() cuts exactly one heading's block and throws on a missing one", () => {
    const md = "# T\n\nintro\n\n## A\n\na1\n\n### A.1\n\nx\n\n## B\n\nb1\n";
    expect(section(md, "## A")).toBe("## A\n\na1\n\n### A.1\n\nx");
    expect(section(md, "### A.1")).toBe("### A.1\n\nx");
    expect(() => section(md, "## Missing")).toThrow();
  });
  it("renders headings with unique ids, a toc, tables, code, callouts and external links safely", () => {
    const { html, toc } = renderDoc("## Same\n\n## Same\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = '<b>';\n```\n\n> **Warning** careful\n\n[ext](https://example.com) [int](/docs/keeper) [x](api.md#foo)");
    expect(toc.map((t) => t.id)).toEqual(["same", "same-2"]);
    expect(html).toContain('<div class="doc-table">'); expect(html).toContain("&lt;b&gt;"); expect(html).not.toContain("<b>");
    expect(html).toContain("callout-warn"); expect(html).toContain('target="_blank"'); expect(html).toContain('href="/docs/keeper" data-doc-link'); expect(html).toContain('href="/docs/read-api#foo"');
  });
  it("every internal link in every page points at a page that exists, and every heading id is unique per page", () => {
    for (const p of PAGES.filter((x) => x.kind === "md")) {
      const { html, toc } = renderDoc(p.md);
      expect(new Set(toc.map((t) => t.id)).size, p.slug).toBe(toc.length);
      for (const m of html.matchAll(/href="(\/docs\/[^"#]+)(#[^"]*)?" data-doc-link/g)) expect(pageBySlug(m[1].replace("/docs/", "")), `${p.slug} -> ${m[1]}`).toBeTruthy();
    }
  });
  it("maps repository doc links to site pages", () => {
    expect(mapDocLink("security.md")).toEqual({ to: "/docs/security-model" });
    expect(mapDocLink("docs/api.md#x")).toEqual({ to: "/docs/read-api#x" });
    expect(mapDocLink("deploy.md")).toEqual({ external: "https://github.com/Emmythefirst/Noux/blob/main/deploy.md" });
  });
});

describe("docs search", () => {
  it("finds the right page for real questions", () => {
    expect(searchDocs("refund")[0].entry.slug).toBe("refunds-and-the-hold");
    expect(searchDocs("underpaid").some((h) => h.entry.slug === "refunds-and-the-hold")).toBe(true);
    expect(searchDocs("x-noux-claim").some((h) => ["agents-and-claims", "claims-api", "gateway"].includes(h.entry.slug))).toBe(true);
    expect(searchDocs("upgrade authority")[0].entry.slug).toMatch(/security-model|on-chain-program/);
    expect(searchDocs("ed25519").length).toBeGreaterThan(0);
  });
  it("requires every word, ignores case, and returns nothing for gibberish or an empty query", () => {
    expect(searchDocs("")).toEqual([]);
    expect(searchDocs("zzzqqqxxx")).toEqual([]);
    expect(searchDocs("REFUND")[0]).toEqual(searchDocs("refund")[0]);
    expect(searchDocs("refund zzzqqqxxx")).toEqual([]);
  });
});
