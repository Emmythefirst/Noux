import { z } from "zod";
import { createPool, migrate } from "./db";
import { startKeeperLoop } from "./keeper-loop";

/** Standalone keeper service (use this if you'd rather not embed the keeper in the API process). */
const env = z.object({
  DATABASE_URL: z.string().min(1), RPC_URL: z.string().url(), PROGRAM_ID: z.string().min(32), MINT: z.string().min(32),
  KEEPER_PAYER_B58: z.string().min(40), TICK_SECONDS: z.coerce.number().int().min(3).default(10),
}).parse(process.env);

const pool = createPool(env.DATABASE_URL); await migrate(pool);
const stop = startKeeperLoop({ pool, rpcUrl: env.RPC_URL, programId: env.PROGRAM_ID, mint: env.MINT, payerB58: env.KEEPER_PAYER_B58, tickSeconds: env.TICK_SECONDS });
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { stop(); setTimeout(() => process.exit(0), 500); });
