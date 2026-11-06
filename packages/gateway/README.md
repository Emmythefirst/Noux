# @noux/gateway

Express middleware that makes a paid [x402](https://x402.org) route **referral-aware** on Solana, for [Noux](https://noux.vercel.app). Your route keeps working as before; when a valid buyer-bound claim arrives, the payment goes into a per-sale vault and is split on-chain between merchant, distributor and the protocol fee, leaving a public receipt.

```sh
pnpm add @noux/gateway @noux/core
```

```ts
import { Connection } from "@solana/web3.js";
import { OnchainCampaignReader } from "@noux/core";
import { AnchorChain, createNouxGateway } from "@noux/gateway";

const connection = new Connection(RPC_URL, "confirmed");
const chain = new AnchorChain({ connection, programId, mint, gatewayPayer, merchant });

app.use(createNouxGateway({
  programId, cluster: "devnet", campaign, mint,
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  merchantPayTo, facilitator, connection,
  campaigns: new OnchainCampaignReader(connection, programId),
  opener: chain, settler: chain,
  routes: { "GET /v1/brief": { price: 100_000n } }, // 0.10 USDC
}).middleware);
```

You need a paid x402 route on Solana, a facilitator account, a campaign created in the merchant console, and a small SOL-funded gateway payer key. Full guide, failure paths and security notes: https://noux.vercel.app/docs/gateway · https://noux.vercel.app/docs/failure-paths

Source: https://github.com/Emmythefirst/Noux

Status: devnet only, not audited. API may change before 1.0.
