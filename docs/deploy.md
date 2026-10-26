# Deploying to Railway

One image, two services (same repo, same `Dockerfile`; build context = repo root).

| Service | Start command | Needs |
|---|---|---|
| `api` | `./node_modules/.bin/tsx src/server.ts` (default CMD) | Postgres, RPC, attribution key |
| `keeper` | `./node_modules/.bin/tsx src/keeper.ts` | Postgres, RPC, a funded payer key |

## Environment (set in Railway's variables; never commit)

api: `DATABASE_URL` (Railway Postgres reference), `RPC_URL`, `PROGRAM_ID`, `CLUSTER` (`devnet` | `mainnet`, <= 8 chars,
must equal the cluster tag in the campaigns), `ATTRIBUTION_KEY_B58`, `TRUST_PROXY=1`. Optional limits:
`LIMIT_PER_DISTRIBUTOR_PER_MIN`, `LIMIT_PER_BUYER_PER_MIN`, `LIMIT_PER_CAMPAIGN_PER_MIN`, `LIMIT_PER_IP_PER_MIN`,
`CLAIM_TTL_SECS`, `MAX_PRICE_BASE_UNITS`.

keeper: `DATABASE_URL`, `RPC_URL`, `PROGRAM_ID`, `MINT`, `KEEPER_PAYER_B58`, optional `TICK_SECONDS` (default 10).

Health check: `GET /healthz` (returns only the PUBLIC attribution key).

## Key hygiene
- Use a **fresh** attribution key per cluster. The devnet test key in `spike/keys/` must never be used on mainnet.
- The keeper payer only pays fees/rent and can only settle after the hold; it cannot refund. Fund it with a small SOL float.
- A KMS/HSM signer can replace `LocalKeySigner` (the `ClaimSigner` interface) without touching callers.

## Local verification done
`docker build -t axia-api:local .` then run with the env above: `/healthz` answers, process runs as user `node`.
