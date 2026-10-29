import fs from "node:fs";
import bs58 from "bs58";
import { LocalKeySigner, type ClaimSigner } from "@noux/core";
import type { Config } from "./config";

/**
 * Loads the attribution (claim-signing) key. This key decides which claims the program will honour, so:
 *  - never logged, never returned by any endpoint (LocalKeySigner hides it from JSON/inspect);
 *  - a key FILE must not be readable by group/others (mode 600);
 *  - the `ClaimSigner` interface means a KMS/HSM signer can replace this without touching callers.
 */
/**
 * The keys being retired (see ATTRIBUTION_RETIRING_KEYS_B58). Errors name the position, never the value: these are secrets.
 * A retiring key must differ from the active one and from the others, and there are at most three.
 */
export function loadRetiringSigners(cfg: Pick<Config, "ATTRIBUTION_RETIRING_KEYS_B58">, active: ClaimSigner): ClaimSigner[] {
  const raw = (cfg.ATTRIBUTION_RETIRING_KEYS_B58 ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (raw.length > 3) throw new Error("at most 3 retiring attribution keys");
  const out: ClaimSigner[] = [];
  raw.forEach((k, i) => {
    let s: ClaimSigner;
    try { s = new LocalKeySigner(bs58.decode(k)); } catch { throw new Error(`retiring attribution key #${i + 1} is not a valid base58 secret key`); }
    if (s.publicKey.equals(active.publicKey)) throw new Error(`retiring attribution key #${i + 1} is the same as the active key`);
    if (out.some((o) => o.publicKey.equals(s.publicKey))) throw new Error(`retiring attribution key #${i + 1} is listed twice`);
    out.push(s);
  });
  return out;
}

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
