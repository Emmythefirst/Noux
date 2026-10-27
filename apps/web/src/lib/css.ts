import type { CSSProperties } from "react";

// The design handoff ships exact inline CSS strings. `st` turns one into a React style object so the
// values can be pasted verbatim instead of being re-typed (and drifting).
const memo = new Map<string, CSSProperties>();

export function st(css: string): CSSProperties {
  const hit = memo.get(css);
  if (hit) return hit;
  const out: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!prop || !val) continue;
    const key = prop.startsWith("--") ? prop : prop.replace(/^-(webkit|moz|ms)-/, (_, v: string) => v[0].toUpperCase() + v.slice(1) + "-").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = val;
  }
  memo.set(css, out as CSSProperties);
  return out as CSSProperties;
}
