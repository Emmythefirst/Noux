/**
 * Return USDC and token-account rent from the throwaway buyers a load test saved (gateway-load.ts writes /tmp/noux-load-buyers-*.json), then delete the files.
 *   set -a; . ../../.env; set +a; pnpm tsx scripts/sweep-buyers.ts
 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createTransferInstruction, createCloseAccountInstruction, getAccount } from "@solana/spl-token";
process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
const conn = new Connection(process.env.RPC_URL!, "confirmed"), USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const files = fs.readdirSync(os.tmpdir()).filter((f) => /^noux-load-buyers-\d+\.json$/.test(f)).map((f) => path.join(os.tmpdir(), f));
const keys = new Map<string, Keypair>(); for (const f of files) for (const k of JSON.parse(fs.readFileSync(f, "utf8")) as number[][]) { const kp = Keypair.fromSecretKey(Uint8Array.from(k)); keys.set(kp.publicKey.toBase58(), kp); }
const payerAta = getAssociatedTokenAddressSync(USDC, payer.publicKey);
let usdc = 0n, closed = 0, scanned = 0; const list = [...keys.values()];
for (let i = 0; i < list.length; i += 4) {
  const grp = list.slice(i, i + 4), ixs: any[] = [], signers: Keypair[] = [payer];
  for (const b of grp) { scanned++; const a = getAssociatedTokenAddressSync(USDC, b.publicKey);
    try { const acc = await getAccount(conn, a); if (acc.amount > 0n) { ixs.push(createTransferInstruction(a, payerAta, b.publicKey, acc.amount)); usdc += acc.amount; } ixs.push(createCloseAccountInstruction(a, payer.publicKey, b.publicKey)); signers.push(b); closed++; } catch { /* no token account: nothing to return */ } }
  if (ixs.length) await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers);
}
console.log(`scanned ${scanned} buyers from ${files.length} files: returned ${usdc} base units of USDC and closed ${closed} token accounts`);
for (const f of files) fs.unlinkSync(f); console.log(`deleted ${files.length} key files`);
