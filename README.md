# Noux

**Pay-for-performance referrals for paid x402 services on Solana.** A merchant who sells a paid API sets up a campaign: a commission rate and a *capped* commission budget. A person or an AI agent (a *distributor*) refers a buyer. When that buyer pays, one on-chain settlement splits the payment between merchant, distributor and the protocol fee, and leaves a public receipt anyone can verify in their browser.

> **Status: devnet only, not audited.** Everything below runs on Solana devnet with test USDC. There are no real customers yet. Services marked *sample* were built by us for demonstration; their volume is not market demand.

| | |
|---|---|
| Website | https://noux.vercel.app |
| API | https://noux-api.onrender.com/v1 (read-only, CORS open; see [docs/api.md](docs/api.md)) |
| Sample merchant | https://noux-demo-merchant.onrender.com (sells two clearly-labelled sample endpoints through the gateway) |
| Program (devnet) | `AC6AtoRALLszNGNLmHte2UXKzCqBYQKhPdtq5qs77nkL` |
| Hackathon | Encode Club × Solana Foundation, Solana Hackathon 2026 (tracks: Best Consumer App, Best Use of x402) |

Free-tier hosting: the API and sample merchant sleep when idle and can take up to a minute to wake. The site says so while it waits.

## How a sale works

1. **Merchant** creates a campaign on-chain (commission up to 50%, commission budget, refund hold up to 600 s). The **protocol fee is not the merchant's choice**: it is copied from a global on-chain config (max 5%).
2. **Distributor** shares the service. Their wallet address is their referral ID; nothing to sign up for.
3. **Buyer** asks the claim service for a signed, buyer-bound claim (60 s-fresh request signed by the buyer), then calls the merchant's paid route with it in `x-noux-claim`.
4. The merchant's **gateway** checks the claim, opens a per-sale vault on-chain and answers `402` with that vault as `payTo`. The buyer pays through standard x402 (`exact` scheme, Coinbase CDP facilitator).
5. After the hold, the **program splits** the vault: fee and commission rounded down, commission capped by the remaining budget, the merchant gets the remainder. The merchant may settle immediately after delivering; anyone else must wait out the hold (a keeper does).
6. Before settlement the merchant can **refund** the buyer in full (no commission, no fee). After settlement it is final. Refund rates are public.

Without a valid claim a call is a plain purchase: the merchant is paid in full and no commission exists.

## What is built

- **Anchor program** (`program/`): `init_config`, `update_config`, `create_campaign`, `open_sale`, `settle_sale`, `refund_sale`, `close_expired_sale`. Claims are ed25519-signed, domain-separated and verified through the ed25519 precompile in the same transaction; the sale PDA is seeded by the claim nonce (replay protection).
- **Gateway** (`packages/gateway`): Express middleware around `@x402/express`; exact-price rule, payer = claim buyer, resilient facilitator calls, settlement keeper.
- **Claim + read API** (`apps/api`): rate-limited claim issuance (Postgres), chain indexer, public directory/receipts/distributor/stats endpoints, merchant-signed listings and removals, embedded keeper.
- **Website** (`apps/web`): landing and split simulator, campaign directory, campaign and receipt pages, merchant console (campaigns, sales, receipts, budget, distributors), distributor earnings, docs, settings, light/dark mode, any Solana wallet (Wallet Standard).
- **Browser-side receipt verification**: the receipt page reads the sale and campaign accounts and both transactions straight from a Solana node and re-does four checks (claim signature, payer = claim buyer, split matches the terms and the page, parts sum). No Noux server is involved in those checks.

## What is **not** built or not true yet

- Mainnet. Devnet only. A mainnet smoke test is planned before the deadline.
- An independent audit. The program upgrade authority and the fee-config admin are each **one key** (disclosed on the site).
- Pilot merchants. None yet.
- Real-money checkout. The buy page (`/buy/<campaign>?ref=<wallet>`) lets a person pay with a wallet, but only on devnet and only for GET endpoints that allow browser payments. There is no `noux.so` short domain.
- Published packages. `@noux/gateway` is a workspace package, not on npm; the `npx noux …` commands in the docs page show intended names.
- A commission budget that is escrowed. It is a **cap** (nothing is locked); there is no top-up instruction.
- Abuse resistance beyond rate limits and public metrics: see [docs/security.md](docs/security.md) for what is and is not protected.

## Prior art

We do not claim to have invented this. Referral/affiliate payouts for x402 services exist (for example Pyrimid on Base and Chest Gate on Solana). Noux's angle is the combination: on-chain per-sale vaults on Solana, a buyer-bound claim, a refund-safe hold, an enforced protocol fee, and receipts that verify without trusting our servers.

## Run it

Requirements: Node 24, pnpm 11 (`corepack enable`), Docker (for Postgres in tests).

```bash
pnpm install
pnpm -r typecheck
pnpm -r test            # core 12, gateway 45, api 61, demo-merchant 16, web 26 (+4 opt-in live)
pnpm --filter @noux/web dev        # website on :5173, talks to the live devnet API by default
```

API tests need Postgres: `docker run -d -p 54329:5432 -e POSTGRES_PASSWORD=devonly -e POSTGRES_DB=noux postgres` (override with `DATABASE_URL_TEST`).

**See a real sale end to end** (needs a devnet wallet with a little SOL and devnet USDC; see [docs/deploy.md](docs/deploy.md)):

```bash
cd apps/api && pnpm demo-buy    # claim -> x402 payment -> settlement -> public receipt, plus the two fallbacks
```

**Program checks** on a local validator (22 checks, every failure asserts the specific program error): see the header of `apps/api/scripts/fee-local.ts`.

## Repository layout

```
program/              Anchor program (Rust)
packages/core         claim/listing signing, PDAs, IDL, on-chain readers
packages/gateway      merchant gateway middleware, resilient facilitator, keeper
apps/api              claim service, indexer, public API, embedded keeper
apps/demo-merchant    sample merchant service (reference gateway integration)
apps/web              website (Vite + React + TypeScript)
docs/                 api.md, architecture.md, security.md, deploy.md
```

## Docs

- [Architecture and settlement](docs/architecture.md)
- [Security model, trust assumptions, known limits](docs/security.md)
- [Public API](docs/api.md)
- [Deploying](docs/deploy.md)

## Disclosure

Distributors earn a commission when a buyer they referred pays for a service. Listings and rankings are not endorsements. If you are paid to recommend something, say so.
