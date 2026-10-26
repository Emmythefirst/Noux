import type pg from "pg";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { AnchorKeeperChain, Keeper } from "@noux/gateway";
import { PgSeenStore } from "./seen-store";

export interface KeeperLoopOptions { pool: pg.Pool; rpcUrl: string; programId: string; mint: string; payerB58: string; tickSeconds: number; log?: (m: string) => void }

/** Starts the settlement keeper loop. Returns a stop function. It signs only as a NON-merchant caller: it cannot refund or settle inside the hold. */
export function startKeeperLoop(o: KeeperLoopOptions): () => void {
  const payer = Keypair.fromSecretKey(bs58.decode(o.payerB58));
  const keeper = new Keeper({
    chain: new AnchorKeeperChain({ connection: new Connection(o.rpcUrl, "confirmed"), programId: new PublicKey(o.programId), mint: new PublicKey(o.mint), payer }),
    seen: new PgSeenStore(o.pool),
  });
  const log = o.log ?? ((m: string) => console.log(m));
  log(`keeper up payer=${payer.publicKey.toBase58()} every ${o.tickSeconds}s`);
  // An unfunded payer makes every settle fail; say so loudly instead of failing quietly forever.
  const MIN_LAMPORTS = 10_000_000; // 0.01 SOL
  const conn = new Connection(o.rpcUrl, "confirmed");
  const checkFunds = () => conn.getBalance(payer.publicKey).then((b) => { if (b < MIN_LAMPORTS) log(`WARNING: keeper payer ${payer.publicKey.toBase58()} has only ${b / 1e9} SOL; settles will fail until it is funded`); }).catch(() => {});
  void checkFunds();
  const fundsTimer = setInterval(checkFunds, 10 * 60 * 1000);
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await keeper.tick();
        if (r.settled.length || r.closed.length || r.failed.length) log(JSON.stringify({ settled: r.settled.length, closed: r.closed.length, waiting: r.waiting, failed: r.failed }));
      } catch (e) { log(`keeper tick error: ${String((e as Error).message).slice(0, 160)}`); }
      await new Promise((res) => setTimeout(res, o.tickSeconds * 1000));
    }
  })();
  return () => { stopped = true; clearInterval(fundsTimer); };
}
