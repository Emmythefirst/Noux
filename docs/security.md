# Security model, trust assumptions and known limits

Status: devnet, **no independent audit**. Read this before putting real money near it.

## What the program enforces (on-chain)

- **Claims cannot be forged, edited or reused.** `open_sale` requires an ed25519 signature by the campaign's attribution key over the exact claim (program id, cluster, campaign, distributor, buyer, expiry, price, nonce). The Sale account is a PDA of campaign + nonce, so a second use of a claim fails at account creation.
- **Expired claims and self-referral are rejected.**
- **Terms are frozen per sale.** Commission and fee rates are copied into the sale when it opens.
- **The split is exact and capped.** Floors, commission limited by the remaining budget, merchant gets the remainder, parts sum to the payment. A vault holding less than the claim price cannot settle.
- **Only the merchant can refund, and only before settlement.** A refund returns the whole vault to the claim's buyer; no commission or fee is paid.
- **Third parties cannot settle early.** Before `hold_until` only the merchant can settle.
- **The protocol fee cannot be bypassed by a merchant.** `create_campaign` takes no fee or fee wallet; they come from the global config (max 5%). Only the upgrade authority can create the config; only the admin can change it, and only for campaigns created afterwards.

## What the gateway and claim API enforce (off-chain)

- A claim's price must equal the route price exactly, and the payer must be the claim's buyer. These checks live in the **merchant's gateway**: a merchant who serves a paid route without the gateway gets on-chain attribution and the on-chain split, but not these two checks.
- Claim requests are signed by the buyer (60 s freshness) and rate-limited per distributor, buyer, campaign and IP; there is a maximum price.
- Listings and removals are signed by the campaign's merchant, which the API reads from the chain; messages carry different tags so one cannot be replayed as the other.

## Trust assumptions

- **The attribution key.** One service key signs claims. Whoever holds it decides which distributor a claim names. A leaked key lets an attacker sign claims for campaigns that trust it; claims are still buyer-bound, price-checked at the gateway, and expire, but treat the key as a signing secret (it can be moved to a KMS/HSM through the `ClaimSigner` interface).
- **One upgrade authority and one fee admin.** Today the program upgrade authority is a single wallet, and the config admin is a separate single key. Mainnet needs a multisig plan.
- **Merchants can refund to skip a commission** (deliver, then refund). This is not prevented. Refund counts and rates are public per campaign and per merchant.
- **A merchant can be its own distributor** from another wallet and pay itself commission. The fee is still collected, and the public metrics (distinct buyers, top-buyer share) make it visible, but it is not blocked.
- **Wash trading** can inflate volume. The site never reports sample (our demo) volume as demand and shows real-service volume as "—" until it exists.
- **Free-tier hosting.** The API, keeper and database run on free plans: they sleep, and the free database expires about a month after creation. The merchant's own settlement does not depend on the keeper; the keeper is a backstop.
- **Third-party RPC and facilitator.** Reads and settlement depend on a Solana RPC provider and the Coinbase CDP facilitator.

## Browser and wallet

- The website never sees a private key. Every transaction and message is approved in the user's wallet.
- Receipt verification checks against a Solana node directly. It does not cover transactions that use address lookup tables.

## Known gaps (not hidden)

- No audit, no formal verification, no bug bounty.
- Per-IP rate limiting trusts the first `X-Forwarded-For` hop.
- A commission budget is a cap, not escrow; there is no top-up and no campaign pause/close instruction.
- Rust unit tests do not exist; the program is tested through TypeScript scripts against a local validator and devnet (22 + 13 + 13 checks, with mutation checks for the fee rules).
- Real wallet coverage: create, list/edit and refund were confirmed with Phantom on devnet; other wallets are untested.

## Reporting

Email [YOUR EMAIL] with details. Please do not test against other people's campaigns.
