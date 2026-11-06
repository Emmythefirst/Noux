# @noux/core

Shared building blocks for [Noux](https://noux.vercel.app), a pay-for-performance referral layer for paid x402 APIs on Solana (devnet today):

- the 197-byte, domain-separated **claim** format (build, sign, verify, wire encoding);
- PDA helpers for configs, campaigns and per-sale vaults;
- an on-chain **campaign reader** (single-flight, with a short stale fallback);
- the program **IDL** (`idl`).

```ts
import { OnchainCampaignReader, idl, salePda } from "@noux/core";
```

You normally use this through [`@noux/gateway`](https://www.npmjs.com/package/@noux/gateway). Docs: https://noux.vercel.app/docs/overview · Source: https://github.com/Emmythefirst/Noux

Status: devnet only, not audited. API may change before 1.0.
