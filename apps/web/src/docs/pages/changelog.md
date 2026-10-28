What changed, newest first. Dates are 2026 and times are not recorded. This is devnet work; nothing here is a mainnet release.

## Oct 28

- **Docs** written: README, architecture, security model, and this documentation site.
- **Contact and fixes:** receipt pages refresh themselves while a sale is open; the indexer can no longer lose or roll back finished receipts; wallet confirmation uses the right validity window.
- **Underpaid sales** (vault holds less than the claim price) are labelled as such instead of "Held".
- **Remove from directory** (merchant-signed) and **List this campaign / Edit listing** for a campaign's own merchant.
- **Settings page**, **dark mode**, **hamburger menu**, a merchant console with real pages for campaigns, sales, receipts, budget and distributors.
- **Real-wallet signing confirmed** with Phantom on devnet: create campaign, list and edit, refund.
- **Website deployed** at noux.vercel.app.
- **Browser-side receipt verification:** the receipt page re-checks the claim signature, payer, split and sum against a Solana node.
- **Wallet connect** (any Solana wallet): create campaigns, publish listings, refund.
- **Protocol fee enforced on-chain** through a global config (max 5%); merchants can no longer choose the fee or the fee wallet. Program upgraded in place on devnet.
- Demo campaign replaced by one with the enforced fee.

## Oct 27

- **Public read API, indexer and merchant-signed listings** deployed.
- **Sample merchant service** and a scripted buyer agent; the first live end-to-end sale with a public receipt.
- **Hosting** on Render (API, sample merchant, Postgres).
- Project renamed to **Noux**.

## Oct 26

- **Program** with per-sale vaults, ed25519-verified buyer-bound claims, settle, refund-safe hold, refund and close-expired instructions.
- **Gateway, claim service and keeper**; hardening (payer binding, domain-separated claims, exact-price rule) verified on devnet with the Coinbase facilitator.
- Feasibility spike: a program-owned vault works as an x402 `payTo`.
