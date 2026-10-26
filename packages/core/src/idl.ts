import { createRequire } from "node:module";
// Synced from program/target/idl/noux.json by `pnpm sync-idl` (the build output itself is git-ignored).
const require = createRequire(import.meta.url);
export const idl = require("../idl/noux.json");
