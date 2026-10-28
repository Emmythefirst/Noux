import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";

const src = path.resolve(import.meta.dirname, "../src");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]));
const tokens = fs.readFileSync(path.join(src, "tokens.css"), "utf8");

describe("theme tokens", () => {
  it("every colour used in the source has a light and a dark token (run scripts/gen-tokens.mjs after adding one)", () => {
    const used = new Set<string>();
    for (const f of walk(src).filter((p) => /\.(tsx?|css)$/.test(p) && !p.endsWith("tokens.css"))) for (const m of fs.readFileSync(f, "utf8").matchAll(/#([0-9a-fA-F]{6})\b/g)) used.add(m[1].toLowerCase());
    const [light, dark] = tokens.split(':root[data-theme="dark"]');
    const missing = [...used].filter((h) => !light.includes(`--c-${h}:`) || !dark.includes(`--c-${h}:`));
    expect(missing).toEqual([]);
  });
  it("dark values differ from light for surfaces and text (so dark mode actually changes them)", () => {
    const val = (blk: string, h: string) => blk.match(new RegExp(`--c-${h}: (#[0-9a-f]{6})`))?.[1];
    const [light, dark] = tokens.split(':root[data-theme="dark"]');
    for (const h of ["ffffff", "fafafa", "111111", "333333", "6b6b6b", "ebebeb"]) expect(val(dark, h)).not.toBe(val(light, h));
  });
});
