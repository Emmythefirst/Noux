# Architecture

```
            buyer / agent                         merchant                         distributor
                 |                                    |                                |
   1. signed claim request (buyer wallet)             |                                |
                 v                                    |                                |
        +------------------+   claim (attribution key signature, buyer-bound)          |
        |  Claim API       |-----------------------------------+                       |
        |  apps/api        |                                   v                       |
        +------------------+                       2. GET route + x-noux-claim         |
                                                   +-------------------+              |
                                                   |  Merchant gateway |              |
                                                   |  packages/gateway |              |
                                                   +---------+---------+              |
              3. open_sale (ed25519 precompile + program) ----+--> Solana program ----+
                 creates Sale PDA + its token vault                 (AC6A…7nkL)
                 4. 402 payTo = vault; buyer pays via x402 (CDP facilitator)
                 5. settle_sale (merchant now, anyone after the hold): split + receipt
                 6. refund_sale (merchant only, before settlement)
        +------------------+
        | Indexer (apps/api)| reads Campaign / Sale accounts -> Postgres -> public /v1 API -> website
        +------------------+
```

## Program (`program/programs/noux/src/lib.rs`)

| Instruction | Who | What |
|---|---|---|
| `init_config` | upgrade authority, once | Creates the global config: admin, fee wallet, fee bps (max 500). |
| `update_config` | config admin | Changes fee/wallet/admin for **future** campaigns only (max 500 bps). |
| `create_campaign` | merchant | Commission (≤5000 bps), commission budget (a cap), hold (≤600 s), attribution key, cluster tag. Fee and fee wallet are copied from the config, not passed in. |
| `open_sale` | gateway (anyone can submit) | Requires the previous instruction to be an ed25519 verify of the claim by the campaign's attribution key. Creates `Sale` (PDA of campaign + nonce) and its vault. Freezes commission/fee bps. |
| `settle_sale` | merchant any time; others after `hold_until` | Splits the vault. Closes the vault. `Sale` stays as the receipt. |
| `refund_sale` | merchant only, while Open | Whole vault back to the claim's buyer; no commission or fee. `Sale` becomes a Refunded receipt. |
| `close_expired_sale` | anyone | Reclaims rent of a sale nobody paid, only after the claim expired and the vault is empty. |

**Claim message** (197 bytes): `NOUX-CLAIM-v1 | program id | cluster tag (8) | campaign | distributor | buyer | expiry | price | nonce`. Binding the program id and cluster stops cross-program and cross-cluster replay; binding the buyer makes a claim useless to anyone else.

**Split rule.** `fee = floor(gross × fee_bps)`, `wanted = floor(gross × commission_bps)`, `commission = min(wanted, budget − spent)`, `merchant = gross − fee − commission`. Parts always sum to the amount paid. If the cap reduces the commission the receipt says so.

**Hold.** A sale cannot be settled by a third party until `hold_until`. The merchant may settle at once (after delivering) and may refund at any time before settlement. The keeper waits the full hold from the first time it sees the vault funded.

## Gateway (`packages/gateway`)

- Accepts a claim only if: signature self-consistent, program/cluster/campaign match, the attribution key equals the one stored **on the campaign on-chain**, **claim price equals the route price exactly**, enough life left, no self-referral. Otherwise it falls back to a plain purchase paid to the merchant.
- Payer binding: after x402 verification, the paying wallet must equal the claim's buyer (otherwise the request is aborted).
- If opening the sale fails the buyer can still buy (merchant paid in full, referral lost); the gateway fails open for buyers.
- The facilitator wrapper retries reads, never blind-retries a settle, checks the chain when a settle outcome is ambiguous, and never re-signs.

## Claim API and indexer (`apps/api`)

- `POST /v1/claims`: buyer-signed request, 60 s freshness; per-distributor / buyer / campaign / IP limits in Postgres under one advisory lock; price cap; the campaign must name this service's attribution key.
- Indexer: snapshots Campaign and Sale accounts about every minute into Postgres (also each open sale's vault balance, because `gross` is zero on-chain until settlement), enriches finished sales with transaction signatures lazily, serves the public read API.
- Keeper: settles funded sales after the hold, closes unpaid ones after expiry, optionally embedded in the API process.

## Website (`apps/web`)

Static Vite/React site. All data comes from the public API; the Solana library is loaded only when a wallet action needs it. Merchant actions (create campaign, list/edit/remove listing, refund) are built in the browser and signed by the user's wallet. Receipt verification talks to a Solana RPC node directly.

## Data

Campaign, Sale and Config accounts are the source of truth. Postgres holds a rebuildable index, the claim-issuance log (rate limits and the "claims issued → paid" figure), and merchant-signed listings (the only off-chain data that cannot be rebuilt from the chain).
