import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { AnchorKeeperChain, Keeper } from "@axia/gateway";
import { createPool, migrate } from "./db";
import { PgSeenStore } from "./seen-store";

/** Settlement keeper process: run as its own service. It only ever signs as a NON-merchant caller (it cannot refund or settle early). */
const env = z.object({
  DATABASE_URL: z.string().min(1), RPC_URL: z.string().url(), PROGRAM_ID: z.string().min(32), MINT: z.string().min(32),
  KEEPER_PAYER_B58: z.string().min(40), TICK_SECONDS: z.coerce.number().int().min(3).default(10),
}).parse(process.env);

const pool = createPool(env.DATABASE_URL); await migrate(pool);
const payer = Keypair.fromSecretKey(bs58.decode(env.KEEPER_PAYER_B58));
const keeper = new Keeper({
  chain: new AnchorKeeperChain({ connection: new Connection(env.RPC_URL, "confirmed"), programId: new PublicKey(env.PROGRAM_ID), mint: new PublicKey(env.MINT), payer }),
  seen: new PgSeenStore(pool),
});
console.log(`keeper up payer=${payer.publicKey.toBase58()} every ${env.TICK_SECONDS}s`);
let stopping = false; for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { stopping = true; });
while (!stopping) {
  const r = await keeper.tick();
  if (r.settled.length || r.closed.length || r.failed.length) console.log(JSON.stringify({ settled: r.settled.length, closed: r.closed.length, waiting: r.waiting, failed: r.failed }));
  await new Promise((res) => setTimeout(res, env.TICK_SECONDS * 1000));
}
await pool.end();
