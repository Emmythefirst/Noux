import { createRequire } from "node:module";
// Synced from axia/target/idl/axia.json by `pnpm sync-idl` (the build output itself is git-ignored).
const require = createRequire(import.meta.url);
export const idl = require("../idl/axia.json");
