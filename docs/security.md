# Security model

Status: devnet. This page describes what the program and the gateway enforce, who holds which keys, and how it was checked.

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
- Claim requests are signed by the buyer (60 s freshness) and rate-limited per distributor, buyer, campaign and IP; there is a maximum price. The per-IP limits use the address our own proxy appended to `X-Forwarded-For` (counted from the right, `TRUSTED_PROXY_HOPS`), never the leftmost entry, which a client can forge; `GET /v1/whoami` shows what the service believes your address is.
- Listings and removals are signed by the campaign's merchant, which the API reads from the chain; messages carry different tags so one cannot be replayed as the other.

## Keys, operations and design choices

- **The attribution key.** One service key signs claims. Whoever holds it decides which distributor a claim names. A leaked key lets an attacker sign claims for campaigns that trust it; claims are still buyer-bound, price-checked at the gateway, and expire, but treat the key as a signing secret (the `ClaimSigner` interface lets it live in a KMS/HSM).
- **Upgrade authority and fee admin.** The program upgrade authority and the config admin are separate keys. Moving both to a multisig vault has been rehearsed on devnet (see multisig-rehearsal.md in the repository).
- **Refunds are public.** A merchant can refund an open sale instead of settling it (no commission is paid then). Refund counts and rates are public per campaign and per merchant.
- **Self-dealing is visible.** A merchant acting as its own distributor from another wallet still pays the protocol fee, and the public metrics (distinct buyers, top-buyer share) show it.
- **Volume is labelled honestly.** The site never reports sample (our demo) volume as demand and shows real-service volume as "—" until it exists.
- **Hosting.** The API, keeper and database run on free plans while on devnet. The merchant's own settlement does not depend on the keeper; the keeper is a backstop.
- **Third-party RPC and facilitator.** Reads and settlement depend on a Solana RPC provider and the Coinbase CDP facilitator.

## Browser and wallet

- The website never sees a private key. Every transaction and message is approved in the user's wallet.
- Receipt verification checks against a Solana node directly. It was run against real v0 transactions that use an address lookup table (on a local validator, through `apps/web/test/verify-alt.test.ts`) and passes;
- Wallets must expose `solana:signTransaction` (the buy page needs it because the facilitator, not the wallet, submits the payment). Wallets that can only sign-and-send are not listed.
- Claim requests are plain text signed with `signMessage`. A hardware wallet that cannot sign arbitrary text cannot request a claim.
- Before signing, the site checks the wallet offers the site's network (devnet) and says so if not. For a payment it also checks the wallet signed exactly the transaction the site built; a wallet that adds its own instructions first (for example a safety guard) is refused with a clear message, because its signature would not match what the facilitator receives. Phantom on devnet passed this.

## The gateway payer's SOL float

- Opening a sale happens on the buyer's first (unpaid) request, before any payment, and the gateway payer fronts about 0.0034 SOL of rent for it. Anyone can create free buyer wallets and ask the claim service for claims, so the claim limits (30 per distributor, 10 per buyer, 60 per IP, 120 per campaign, per minute) are the only brake: at the campaign limit an attacker can tie up roughly 0.4 SOL per minute until those unpaid sales expire (10 minutes) and the keeper closes them and returns the rent. A payer with a small float then runs dry, the gateway **fails open** (the buyer still buys, the merchant is paid in full, the referral is lost) and no money is stolen. This is analysis of the code and the limits, not something we have attacked live.
- Keep the payer funded for the campaign limit, watch its balance (the demo merchant's `/v1/status` reports it), and run a keeper so expired sales are closed.

## The buy page (`/buy/<campaign>?ref=<wallet>`)

- **The page checks the 402 against the campaign and its listing before the wallet is asked.** It refuses (and says why) if the service asks for a different token than the campaign's, a different network, an unsupported scheme, or an amount outside the listed price (an exact listed price must match; a listed range such as `$0.03-$0.10` accepts anything inside it; a listing with no readable number cannot be compared and is not blocked). The payee (`payTo`) is not checked: it is the sale vault for a referred purchase and the merchant's wallet for a plain one, and the page cannot tell which is honest, so the wallet's own approval prompt remains the last line of defence. The claim service's maximum price still caps referred purchases.
- **The page does not verify the merchant.** It pays any listed `https` endpoint that answers x402. A listing is a signed claim by that merchant, not an endorsement by Noux.
- **The referrer is whatever `ref` says.** The link carries a wallet address; nothing proves the referrer shared it. A link can be edited to name a different wallet, and a person can run campaigns by promoting with their own wallet in the link.
- **Purchase memory is local.** The "you already paid" note is stored in the browser's `localStorage`: clearing site data, using another browser or another device removes it, and the page will let the buyer pay again. The public receipt is the real record.
- **Browser payments depend on the merchant's CORS headers.** A merchant that does not allow them cannot be bought from the page.
- **Devnet only.** There is no real-money checkout.

## How it was checked

- **Arithmetic and claim format.** The settlement arithmetic and claim message have Rust unit tests (`cargo test -p noux --lib`): the split sums exactly and respects the fee, rate and budget rules over 500,000 generated cases plus edges, checked against a second algorithm, plus the 197-byte claim layout and the upgrade-authority parser. Five deliberate arithmetic and claim-message bugs were each caught.
- **Instructions and account checks** run through TypeScript scripts against a local validator and devnet (22 + 11 + 13 + 13 checks).
- **Budgets and campaign controls.** A commission budget is a cap: a merchant can raise it but never lower it. A merchant can pause, resume or permanently end new referral sales (enforced on-chain by `open_sale`); ending never deletes the campaign account, because receipt verification reads it.
- **Key rotation.** A merchant can rotate the attribution key (effective at once on-chain). Rotating the claim service's own key works through an overlap: the service signs with the key each campaign trusts (runbook in docs/deploy.md).
- **Load.** The gateway ran against the real chain and facilitator with up to 100 concurrent buyers and 80 spread-out real purchases (see docs/deploy.md). The indexer ran with up to 50,000 synthetic sales (sync under 2 s, API under about 200 ms) and follows new transactions incrementally, verified equal to a full snapshot on real devnet.
- **Wallets and screens.** Create, list/edit, refund and a buy-page payment were confirmed with Phantom on devnet. The merchant console was checked on phone-sized screens (320 to 390 px).
- **Multisig.** Handing a program to a 2-of-3 Squads vault, upgrading and closing it through proposals was run on devnet.

## Reporting

Email ehonemmanuel7@gmail.com with details. Please do not test against other people's campaigns.
