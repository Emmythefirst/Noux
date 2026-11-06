import { defineConfig } from "tsup";

// One ESM bundle plus type declarations. Dependencies stay external (npm installs them); the workspace keeps pointing at src/ for development.
export default defineConfig({ entry: ["src/index.ts"], format: ["esm"], dts: true, clean: true, target: "node20", sourcemap: false });
