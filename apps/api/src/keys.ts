import fs from "node:fs";
import bs58 from "bs58";
import { LocalKeySigner, type ClaimSigner } from "@axia/core";
import type { Config } from "./config";

/**
 * Loads the attribution (claim-signing) key. This key decides which claims the program will honour, so:
 *  - never logged, never returned by any endpoint (LocalKeySigner hides it from JSON/inspect);
 *  - a key FILE must not be readable by group/others (mode 600);
 *  - the `ClaimSigner` interface means a KMS/HSM signer can replace this without touching callers.
 */
export function loadSigner(cfg: Pick<Config, "ATTRIBUTION_KEY_FILE" | "ATTRIBUTION_KEY_B58">): ClaimSigner {
  if (cfg.ATTRIBUTION_KEY_FILE) {
    const st = fs.statSync(cfg.ATTRIBUTION_KEY_FILE);
    if (st.mode & 0o077) throw new Error(`attribution key file must not be group/world accessible (chmod 600): ${cfg.ATTRIBUTION_KEY_FILE}`);
    const arr = JSON.parse(fs.readFileSync(cfg.ATTRIBUTION_KEY_FILE, "utf8"));
    if (!Array.isArray(arr)) throw new Error("attribution key file must be a JSON array of 64 bytes");
    return new LocalKeySigner(Uint8Array.from(arr));
  }
  if (cfg.ATTRIBUTION_KEY_B58) return new LocalKeySigner(bs58.decode(cfg.ATTRIBUTION_KEY_B58));
  throw new Error("no attribution key configured (set ATTRIBUTION_KEY_FILE or ATTRIBUTION_KEY_B58)");
}
