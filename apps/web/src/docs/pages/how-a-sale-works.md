One sale, six steps. Each one is a real transaction or a real signed message you can look up.

1. **The merchant creates a campaign** on-chain: commission (up to 50%), a commission budget, a refund hold (up to 600 seconds). The protocol fee and fee wallet are copied from the program's global config; the merchant cannot choose them.
2. **A distributor shares the service.** Their wallet address is their referral ID.
3. **The buyer asks for a claim.** The buyer signs a request (fresh within 60 seconds) naming the campaign, the distributor and the price. The claim service checks it and returns a claim signed by the campaign's attribution key, bound to that buyer, that distributor, that price and an expiry (10 minutes).
4. **The buyer calls the paid route** with the claim in the `x-noux-claim` header. The merchant's gateway checks the claim, opens a per-sale vault on-chain and answers `402 Payment Required` with that vault as the payee. The buyer pays through standard x402.
5. **The program splits the payment.** The merchant can settle right after delivering; anyone else must wait out the hold (the [keeper](/docs/keeper) does). Fee and commission are rounded down, commission is capped by the remaining budget, and the merchant gets the remainder.
6. **The sale stays on-chain as the receipt.** Before settlement the merchant can [refund](/docs/refunds-and-the-hold) the buyer in full. After settlement it is final.

Without a valid claim a call is a plain purchase: the merchant is paid in full and no commission exists.

## The pieces
