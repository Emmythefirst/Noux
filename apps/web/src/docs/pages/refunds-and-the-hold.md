## The hold

Every sale has a hold, set by the campaign (up to 600 seconds), counted from when the sale opens. Until the hold ends only the **merchant** can settle it. After the hold anyone can, which is how the [keeper](/docs/keeper) settles sales for merchants who do not settle themselves.

The hold exists so a merchant has time to notice a failed delivery and refund before the money is split.

## Refunds

While a sale is open (not yet settled) the merchant wallet can refund it:

- The whole vault goes back to the buyer named in the claim.
- No commission and no protocol fee are paid.
- The sale stays on-chain as a **Refunded** receipt.
- After settlement a sale is final. There is no refund of a settled sale.

In the merchant console, **My sales** shows a **Refund** button on every open funded sale. Your wallet approves the refund; the row changes to Refunded immediately and the public index catches up within a minute.

> **Note** A refund is the merchant's choice, not a guarantee to the buyer. Noux does not make refunds automatic and does not promise "complete refund protection".

## Underpaid sales

If the vault holds money but less than the claim price, the program refuses to settle it (error `Underpaid`) and the keeper skips it. The site shows these as **Underpaid · can't settle**. The merchant can refund them.

## Abuse and how it is limited

A merchant could deliver the service and then refund to avoid paying the commission. This is not prevented. It is limited by the hold and made visible: refund counts and refund rates are public per campaign, shown on the directory, the campaign page and every receipt.
