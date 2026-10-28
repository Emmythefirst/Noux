A campaign is the on-chain record of your terms. Create one from **My campaigns → Create campaign** in the merchant console; your wallet approves one transaction and one listing message.

## The terms

| Term | Range | Notes |
|---|---|---|
| Commission | 1% to 50% | Paid to the distributor named in the claim. |
| Commission budget | any amount | A **cap**, not money held by Noux. See below. |
| Refund hold | 0 to 600 seconds | How long you have to refund a failed call before anyone else can settle. |
| Protocol fee | set by the program, max 5% | Copied from the global config when the campaign is created. You cannot change it or redirect it. |
| Cluster | devnet today | Part of every claim, so claims cannot cross clusters. |

Terms are written on-chain when the campaign is created. There is no edit instruction yet, so choose carefully.

## The budget is a cap

The commission budget limits how much commission the campaign can ever pay. Nothing is locked: each sale pays its commission out of that sale's own payment. When the cap is reached, buyers still pay, you keep the rest of every sale, and you simply stop paying commission. If a sale is only partly covered by what is left, the receipt says "budget cap reduced commission".

There is no top-up and no pause or close instruction yet. The merchant console's **Budget** page shows, per campaign, the cap, what has been paid out, what is left and an estimate of how many more sales it covers.

## Listing

A campaign exists on-chain without a listing; the **listing** is the name, description, category, endpoint URL, route and price you sign with your wallet so people can find it. Only listed campaigns appear in the public directory.

- **List this campaign / Edit listing** on the campaign page (visible to the campaign's own merchant wallet).
- **Remove from directory** hides it again; the campaign itself stays on-chain and keeps working for anyone with the link.
- An **unlisted** campaign is a private campaign. The page tells visitors that its merchant has not published a listing and to promote it only if they trust the merchant.

## Legacy campaigns

Campaigns created before the protocol fee was enforced have a fee chosen by their creator and are marked "legacy". New campaigns always use the program's fee.
