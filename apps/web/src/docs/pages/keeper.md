The keeper is the backstop that settles sales when the merchant does not. It is a small loop, not a trusted party: it signs only as an ordinary caller, so it **cannot refund and cannot settle inside the hold**.

## What it does

Every tick (30 seconds by default) it lists open sales and, for each one:

- **Settles** it once the vault holds at least the claim price, the on-chain hold has passed, **and** the keeper itself has seen the vault funded for the full hold (the first time it saw the funds is stored in Postgres, so a restart does not shorten the wait).
- **Closes** it if nobody paid and the claim has expired, returning the rent.
- **Skips** underpaid sales (the program would reject them).

If a merchant settles or refunds at the same moment, the chain decides: the other call fails harmlessly.

## Running it

- **Embedded.** The Noux API runs a keeper inside its own process when `MINT` and `KEEPER_PAYER_B58` are set. This is how the public demo works.
- **Standalone.** `apps/api/src/keeper.ts` runs the same loop as its own process (`DATABASE_URL`, `RPC_URL`, `PROGRAM_ID`, `MINT`, `KEEPER_PAYER_B58`, `TICK_SECONDS`).
- **Anyone can run one.** Settlement is permissionless after the hold.

The keeper payer needs a small SOL balance for fees and rent; it logs a warning when it runs low. Use a fresh key per cluster.

