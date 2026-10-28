// The documentation site. Pages are markdown files (apps/web/src/docs/pages) plus the repository's own docs (docs/*.md),
// composed here so there is ONE source for each topic: edit the markdown and both GitHub and the website change.
import apiMd from "../../../../docs/api.md?raw";
import archMd from "../../../../docs/architecture.md?raw";
import securityMd from "../../../../docs/security.md?raw";
import overview from "./pages/overview.md?raw";
import howASale from "./pages/how-a-sale-works.md?raw";
import gateway from "./pages/gateway.md?raw";
import campaigns from "./pages/campaigns-and-budgets.md?raw";
import refunds from "./pages/refunds-and-the-hold.md?raw";
import keeper from "./pages/keeper.md?raw";
import referral from "./pages/referral-links.md?raw";
import agents from "./pages/agents-and-claims.md?raw";
import claimsApi from "./pages/claims-api.md?raw";
import onchain from "./pages/on-chain-program.md?raw";
import changelog from "./pages/changelog.md?raw";

export type DocKind = "md" | "quickstart" | "status";
export interface DocPage { slug: string; title: string; group: string; kind: DocKind; md: string; source: string }

const dropH1 = (md: string) => md.replace(/^# .*\n+/, "");
/** From the heading that starts with `heading` to the next heading of the same or a higher level (heading line included). */
export function section(md: string, heading: string): string {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.startsWith(heading));
  if (i < 0) throw new Error(`docs: section "${heading}" not found`);
  const level = lines[i].match(/^#+/)![0].length;
  let j = i + 1;
  while (j < lines.length && !(/^#+ /.test(lines[j]) && lines[j].match(/^#+/)![0].length <= level)) j++;
  return lines.slice(i, j).join("\n").trimEnd();
}
/** Everything before the first `## ` heading (after the title). */
const preamble = (md: string) => dropH1(md.split(/^## /m)[0]).trim();
const join = (...p: string[]) => p.join("\n\n");

const GH = "https://github.com/Emmythefirst/Noux/blob/main/";
export const PAGES: DocPage[] = [
  { slug: "overview", title: "Overview", group: "Getting started", kind: "md", md: overview, source: "apps/web/src/docs/pages/overview.md" },
  { slug: "quickstart", title: "Quickstart", group: "Getting started", kind: "quickstart", md: "", source: "apps/web/src/docs/QuickstartPage.tsx" },
  { slug: "how-a-sale-works", title: "How a sale works", group: "Getting started", kind: "md", md: join(howASale, preamble(archMd), section(archMd, "## Website"), section(archMd, "## Data")), source: "docs/architecture.md" },
  { slug: "gateway", title: "Gateway", group: "Merchants", kind: "md", md: gateway, source: "apps/web/src/docs/pages/gateway.md" },
  { slug: "campaigns-and-budgets", title: "Campaigns and budgets", group: "Merchants", kind: "md", md: campaigns, source: "apps/web/src/docs/pages/campaigns-and-budgets.md" },
  { slug: "refunds-and-the-hold", title: "Refunds and the hold", group: "Merchants", kind: "md", md: refunds, source: "apps/web/src/docs/pages/refunds-and-the-hold.md" },
  { slug: "keeper", title: "Keeper", group: "Merchants", kind: "md", md: join(keeper, section(archMd, "## Claim API and indexer")), source: "docs/architecture.md" },
  { slug: "referral-links", title: "Referral links", group: "Distributors", kind: "md", md: referral, source: "apps/web/src/docs/pages/referral-links.md" },
  { slug: "agents-and-claims", title: "Agents and claims", group: "Distributors", kind: "md", md: agents, source: "apps/web/src/docs/pages/agents-and-claims.md" },
  { slug: "read-api", title: "Read API", group: "Reference", kind: "md", md: dropH1(apiMd), source: "docs/api.md" },
  { slug: "claims-api", title: "Claims API", group: "Reference", kind: "md", md: claimsApi, source: "apps/web/src/docs/pages/claims-api.md" },
  { slug: "on-chain-program", title: "On-chain program", group: "Reference", kind: "md", md: join(section(archMd, "## Program"), onchain), source: "docs/architecture.md" },
  { slug: "security-model", title: "Security model", group: "Trust", kind: "md", md: dropH1(securityMd), source: "docs/security.md" },
  { slug: "status", title: "Status", group: "Trust", kind: "status", md: "", source: "apps/web/src/docs/StatusPage.tsx" },
  { slug: "changelog", title: "Changelog", group: "Trust", kind: "md", md: changelog, source: "apps/web/src/docs/pages/changelog.md" },
];
export const GROUPS = [...new Set(PAGES.map((p) => p.group))].map((g) => ({ title: g, pages: PAGES.filter((p) => p.group === g) }));
export const pageBySlug = (s: string) => PAGES.find((p) => p.slug === s);
export const githubUrl = (p: DocPage) => GH + p.source;

/** Where a relative link inside the markdown should go on the website. */
export function mapDocLink(href: string): { to: string } | { external: string } {
  const base = href.split("#")[0].replace(/^\.?\/?(docs\/)?/, "");
  const hash = href.includes("#") ? "#" + href.split("#")[1] : "";
  const m: Record<string, string> = { "api.md": "read-api", "architecture.md": "how-a-sale-works", "security.md": "security-model" };
  if (m[base]) return { to: `/docs/${m[base]}${hash}` };
  if (href.startsWith("/")) return { to: href };
  if (/^https?:|^mailto:/.test(href)) return { external: href };
  return { external: GH + base };
}
