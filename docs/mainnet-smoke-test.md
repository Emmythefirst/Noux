# Mainnet smoke test: runbook

Status: **not run.** Nothing here has been done on mainnet. This is the plan for the small real-money run before the deadline (smoke test about Nov 2, run Nov 5), written from what the devnet review found. Do the steps in order and stop at the first failure.

## 0. Decide before touching mainnet

| Decision | Why it matters | Default if undecided |
|---|---|---|
| Upgrade authority and config admin | Today each is one key. Real money behind one hot key is the largest trust assumption (see security.md). | A fresh hardware or multisig key; never the devnet deploy wallet |
| RPC provider and plan | Purchases are RPC-bound: about 10 RPC calls each, about 1 to 1.5 purchases per second on our devnet plan (docs/deploy.md). Public mainnet RPC will refuse a service of this kind. | A paid mainnet plan with headroom; watch for HTTP 429 |
| Who pays and how much | Program deploy locks roughly 2 SOL of rent (check `solana rent 279872` on mainnet) and needs a larger transient buffer; each referred sale fronts about 0.0034 SOL, of which about 0.0019 stays locked in the receipt | Budget about 4 SOL for the deploy, 0.5 SOL for the gateway payer, 0.1 SOL for the keeper, and 5 to 10 USDC for buyers |
| Domain, brand, short link | Not needed for the smoke test | Keep `noux.vercel.app` |

## 1. Fresh keys (never reuse devnet keys)

Generate new keypairs for: program upgrade authority, config admin, fee wallet, attribution key, keeper payer, gateway payer, merchant, merchant signer (optional). Keep them out of the repo and the chat; load them from the host's secret store. The devnet attribution key and the test keys in `spike/keys/` must not appear anywhere on mainnet.

## 2. Build and deploy the program

1. `cd program && anchor build`; record `sha256sum target/deploy/noux.so`.
2. Deploy with the new upgrade authority (`solana program deploy ... --upgrade-authority <new key>`). The program id is a property of the keypair in `target/deploy/noux-keypair.json`; claims are domain-separated by the cluster tag, so reusing the id on mainnet is safe, but a new keypair is also fine (then update `declare_id!`, the IDL and rebuild).
3. Dump the on-chain program and confirm its bytes equal the build (prefix equal, rest zero padding), as was done on devnet.
4. `init_config` from the upgrade authority: fee wallet, admin (a different key), fee bps (1% on devnet).

## 3. Configure the services for mainnet

| Setting | Value |
|---|---|
| Cluster tag | `mainnet` (7 characters, padded to 8) in every `create_campaign` and in the claim API `CLUSTER` |
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| x402 network | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Facilitator | Coinbase CDP (its `/supported` listed v2 `exact` on Solana mainnet on 2026-10-26; recheck) |
| Web | `VITE_CHAIN=solana:mainnet`, `VITE_RPC_URL` (a keyless or rate-limited endpoint only: it ships to every browser), and remove the DEVNET badges only after the run passes |
| API | `PROGRAM_ID`, `CLUSTER`, `RPC_URL`, fresh `ATTRIBUTION_KEY_B58`, `MINT`, `KEEPER_PAYER_B58`; leave `INDEXER_MODE=incremental` |

## 3b. Run the existing suites against the new configuration first

Unit tests (`pnpm -r test`, `cargo test -p noux --lib`) do not touch the chain and should pass unchanged. The devnet scripts (`devnet-e2e`, `live-check`, `gateway-load`) are written for devnet addresses and the devnet USDC mint; adapt their constants rather than running them as they are.

## 4. The smoke test, with real money (about 0.10 USDC per purchase)

Use the smallest amounts that still exercise every path.

1. **Create a campaign** (commission 15%, budget 5 USDC, hold 120 s) from the merchant console with a fresh wallet. Confirm the on-chain fee equals the config's.
2. **Referred purchase through the API path** (buyer agent: signed claim request, claim, x402 payment). Expect: 200, the exact split, a settled receipt, and the receipt page's four browser checks all green.
3. **Referred purchase through the buy page with a real Phantom wallet.** This is the riskiest step. Phantom is believed to add its own safety instructions to mainnet transactions (not verified). If it does, the site's guard refuses with the message "Your wallet changed the payment transaction before signing it"; that outcome is expected and not a failure of the guard, but it means the buy page needs a different signing approach before launch.
4. **Plain purchase** (no claim) and **lower-priced claim** (must be charged the real price).
5. **Refund** of a held sale from the merchant console, before the hold ends.
6. **Unpaid sale:** open one and leave it; after the claim expires the keeper must close it and return the rent.
7. **Keeper:** let the keeper settle one sale the merchant did not (it waits the whole hold from first sight of the funded vault).
8. **Indexer:** the receipt and directory update within about a minute; `/v1/index` shows `lastMode: incremental` after the first pass.

## 5. Stop conditions (do not continue, do not announce)

- Any split that differs from `fee = floor(gross x fee_bps / 10000)`, `commission = min(floor(gross x commission_bps / 10000), budget left)`, `merchant = rest`.
- Any buyer charged twice, or charged without being served.
- A settle or refund that fails with an unexpected program error.
- Repeated HTTP 429 from the RPC during a single purchase.
- Anything that needs the upgrade key outside a planned step.

## 6. After a pass

Record the transaction signatures and receipt addresses, the program id and the build hash in progress.md; keep the mainnet campaign small and labelled; do not describe the result as an audit or as real demand (volume from our own wallets is a test).
