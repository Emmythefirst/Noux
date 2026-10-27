/**
 * The ONE place the product name lives in TypeScript. Renaming = edit this file, then follow docs/rename-checklist.md
 * for the places that cannot read it (Rust program tag, package scopes, folder names, docs).
 */
export const BRAND = {
  /** Display name. */
  name: "Noux",
  /** lower-case slug used in package names, file names, env prefixes. */
  slug: "noux",
  /** Upper-case prefix of the signed-claim tags. MUST equal the tag compiled into the program (see CLAIM_TAG in lib.rs). */
  tagPrefix: "NOUX",
  /** HTTP header that carries the signed claim from buyer/agent to the merchant gateway. */
  claimHeader: "x-noux-claim",
} as const;

export const CLAIM_TAG = `${BRAND.tagPrefix}-CLAIM-v1`;
export const LISTING_TAG = `${BRAND.tagPrefix}-LISTING-v1`;
export const CLAIM_REQUEST_TAG = `${BRAND.tagPrefix}-CLAIM-REQ-v1`;
/** Length of CLAIM_TAG compiled into the program. A brand whose tag differs in length needs the Rust constant (and message length) updated. */
export const PROGRAM_CLAIM_TAG_LEN = 13;
