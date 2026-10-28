import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The code keeps the design's hex values (readable, greppable); at build time every "#rrggbb" becomes var(--c-rrggbb)
// so the same markup themes light/dark. src/tokens.css defines both values (scripts/gen-tokens.mjs).
const hexTokens = (): Plugin => ({
  name: "hex-tokens",
  enforce: "pre",
  transform(code, id) {
    const file = id.split("?")[0];
    if (!file.includes("/src/") || /tokens\.css$/.test(file) || !/\.(tsx?|css)$/.test(file) || /\/test\//.test(file)) return null;
    return { code: code.replace(/#([0-9a-fA-F]{6})\b/g, (_, h: string) => `var(--c-${h.toLowerCase()})`), map: null };
  },
});

export default defineConfig({ plugins: [hexTokens(), react()], server: { port: 5173 } });
