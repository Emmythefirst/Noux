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
- Claim requests are signed by the buyer (60 s freshness) and rate-limited per distributor, buyer, campaign and IP; there is a maximum price. The per-IP limits use the address our own proxy appended to `X-Forwarded-For` (counted from the right, `TRUSTED_PROXY_HOPS`), never the leftmost entry, which a client can forge; `GET /v1/whoami` shows what the service believes your address is.
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
- Receipt verification checks against a Solana node directly. It was run against real v0 transactions that use an address lookup table (on a local validator, through `apps/web/test/verify-alt.test.ts`) and passes; it has not been run against a lookup-table sale on devnet or mainnet.
- Wallets must expose `solana:signTransaction` (the buy page needs it because the facilitator, not the wallet, submits the payment). Wallets that can only sign-and-send are not listed.
- Claim requests are plain text signed with `signMessage`. A hardware wallet that cannot sign arbitrary text cannot request a claim.
- Before signing, the site checks the wallet offers the site's network (devnet) and says so if not. For a payment it also checks the wallet signed exactly the transaction the site built; a wallet that adds its own instructions first (for example a safety guard) is refused with a clear message, because its signature would not match what the facilitator receives. Phantom on devnet passed this; **mainnet behaviour of any wallet is untested.**

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

## Known gaps (not hidden)

- No audit, no formal verification, no bug bounty.
- A commission budget is a cap, not escrow: a merchant can raise it but never lower it, and there is no campaign pause or close instruction yet.
- The attribution key can be rotated by the merchant (effective at once on-chain). Rotating the Noux claim service's own key still needs a short overlap in which the service signs for both keys; that is not built.
- The settlement arithmetic and claim message have Rust unit tests (`cargo test -p noux --lib`, 9 tests: the split sums exactly and respects the fee, rate and budget rules over 500,000 generated cases plus edges, checked against a second algorithm; the 197-byte claim layout; the upgrade-authority parser). Mutation-checked: five deliberate arithmetic and claim-message bugs were each caught. Instructions and account checks are still tested only through TypeScript scripts against a local validator and devnet (22 + 11 + 13 + 13 checks).
- Real wallet coverage: create, list/edit, refund and a buy-page payment were confirmed with Phantom on devnet; Solflare, Backpack and every other wallet are untested (only a Wallet Standard mock was run), and so is anything on mainnet.
- Load: the gateway was run against the real chain and facilitator with up to 100 concurrent buyers and with 80 spread-out real purchases (see docs/deploy.md); earlier text: up to 40 concurrent buyers (all correct, about 1 to 1.5 purchases per second on our RPC plan; see docs/deploy.md). Not tested: more than 40, long runs, mainnet. The indexer was run with up to 50,000 synthetic sales (sync under 2 s, API under about 200 ms; see docs/deploy.md); the indexer follows new transactions instead of downloading every sale (incremental, verified equal to a full snapshot on real devnet; a full snapshot still runs at start and every 6 hours), and the keeper is untested beyond a few dozen open sales. The merchant console was checked on phone-sized screens (320 to 390 px) in headless Chromium only, not on real devices.

## Reporting

Email ehonemmanuel7@gmail.com with details. Please do not test against other people's campaigns.
