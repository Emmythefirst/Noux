# Renaming the product (single pass)

The name lives in `packages/core/src/brand.ts`. Everything TypeScript reads it from there. What cannot:

1. **Rust program** (`program/programs/<crate>/src/lib.rs`): `CLAIM_TAG`. Keep the tag the same byte length, or update
   `PROGRAM_CLAIM_TAG_LEN` in `brand.ts` and the message length. Rebuild, upgrade, rerun the e2e suites.
2. **Crate / folder names**: `Anchor.toml`, `programs/<crate>/Cargo.toml`, `pub mod <crate>`, the error enum.
   **Gotcha:** the deploy keypair file is named after the crate (`target/deploy/<crate>-keypair.json`). Renaming the crate
   makes Anchor generate a NEW random keypair => a different program id. Copy the old keypair file to the new name first,
   and check `solana address -k target/deploy/<crate>-keypair.json` still equals `declare_id!`.
3. **IDL**: `pnpm --filter @<scope>/core sync-idl` copies `program/target/idl/<crate>.json` into `packages/core/idl/`.
4. **Package scopes** in each `package.json` and every import, the Dockerfile `--filter`, docs, README, UI strings.
5. **Local infra names**: the dev Postgres container/database (`noux-pg`, db `noux`), env defaults in tests.
6. **Outside the repo**: npm org, GitHub org, X handle, domain, Render/Railway service names.

Do the Rust change and redeploy BEFORE any claim is issued to real users: claims signed under the old tag stop verifying.

## Log
- 2026-10-27: Axia -> **Noux**. Tag `AXIA-CLAIM-v1` -> `NOUX-CLAIM-v1` (same 13 bytes), crate/folder `axia/` -> `program/` + `programs/noux`,
  scopes `@axia/*` -> `@noux/*`, header `x-axia-claim` -> `x-noux-claim`. Program id unchanged (`AC6AtoRA...nkL`), devnet program upgraded in place.
