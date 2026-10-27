# Public API (`/v1`)

Read-only except two signed writes. All amounts are strings in the mint's base units (`decimals` is in every response).
CORS is open (`*`); there are no cookies. Responses are cacheable for a few seconds. Data comes from an indexer that
snapshots the program's on-chain accounts about every 20 s; `GET /v1/index` reports how fresh it is.

| Endpoint | What |
|---|---|
| `GET /v1/campaigns` | Directory. Only campaigns with a merchant-signed listing, unless `includeUnlisted=1`. Filters: `category`, `q`, `status=active\|budget_exhausted`, `sort=newest\|commission\|volume`, `limit` (1-100), `offset`. |
| `GET /v1/campaigns/:address` | One campaign: terms, budget, listing, and **metrics** (settled/refunded/open, volume, commissions paid, protocol fees, distinct buyers & distributors, top-buyer share, top distributors). |
| `GET /v1/campaigns/:address/sales` | Receipts of that campaign (`status` filter, paging). |
| `GET /v1/receipts` / `GET /v1/receipts/:sale` | Public receipts: parties, price, exact split, policy applied (commission/fee bps, hold, **whether the budget cap reduced the commission**), refunded?, and explorer links for the open, x402 payment and settlement/refund transactions. |
| `GET /v1/distributors/:pubkey` | A distributor's plain, checkable numbers: eligible purchases, total earned, referred volume, distinct buyers, top-buyer share, per-campaign breakdown, recent sales. No composite "trust score". |
| `GET /v1/stats` | Platform totals. `volumeBySource` splits **sample** (Noux-built demo services) from **listed** and **unlisted** volume: demo volume is never presented as market demand. |
| `GET /v1/index` | Indexer freshness and last error. |
| `PUT /v1/campaigns/:address/listing` | Create/update the directory listing. **Merchant-signed** (below). |
| `POST /v1/claims` | Buyer-signed claim request (see `docs/security.md`). |

## Signed listing
Body: `{ "listing": {name, description, category, endpointUrl, route, displayPrice, website?, isSample}, "ts": <unix s>, "signature": <base64> }`.
The merchant wallet signs `NOUX-LISTING-v1|<campaign>|<sha256 of the canonical listing JSON>|<ts>` (see `packages/core/src/listing.ts`).
The server reads the campaign's merchant **from the chain**, so only the wallet that created the campaign can list it. The request
must be fresh (60 s). URLs must be `https` with no embedded credentials. Stored text has control characters removed.
`category` is one of `ai-text`, `research-search`, `data-feeds`, `developer-tools`, `other`. `isSample: true` is shown prominently in UIs.

## Disclosure
Every directory/detail/stats response carries a `disclosure` string: distributors earn commission on referred purchases, listings
are not endorsements, and `sample` services are demonstrations whose volume is not real demand. UIs must display it.
