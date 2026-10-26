# Renaming the product (single pass)

The name lives in `packages/core/src/brand.ts`. Everything TypeScript reads it from there. What cannot:

1. **Rust program** (`axia/programs/axia/src/lib.rs`): `CLAIM_TAG` (and its length in `claim_message`). Keep the tag the same
   length, or update `PROGRAM_CLAIM_TAG_LEN` in `brand.ts` and the message length. Rebuild, upgrade, rerun `spike/e2e.mjs`.
2. **Program/crate names**: `axia/` folder, `Anchor.toml`, `programs/axia/Cargo.toml`, `declare_id!` stays (same deployed id) unless you redeploy fresh.
3. **Package scopes**: `@axia/core`, `@axia/gateway`, `@axia/api` in each `package.json` and every import.
4. **Docs, README, landing copy, UI strings, security page.**
5. **Registries/handles** (outside the repo): npm org, GitHub org, X handle, domain.

Do the Rust change and redeploy BEFORE any claim is issued to real users: claims signed under the old tag stop verifying.
